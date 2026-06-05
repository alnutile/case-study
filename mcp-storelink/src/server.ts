/**
 * The agent-facing surface (Step 1).
 *
 * Five tools, pitched at the buyer's *decision*, not at StoreLink's eight REST
 * endpoints:
 *
 *   list_stores           which stores this server can actually act for
 *   lookup_sku            product + supplier facts in one call
 *   check_stock_position  the detective work, done server-side and deterministic
 *   raise_replenishment   the one write, gated by a required reason
 *   get_recent_activity   read back the audit log (the buyer's view)
 *
 * Deliberately NOT exposed: raw inventory/POS endpoints (the agent should not
 * re-derive the gap and get the arithmetic wrong), a standalone supplier tool
 * (folded into lookup_sku / check_stock_position), and any write that skips the
 * audit trail.
 *
 * Every handler shares one spine: a request id, a structured log line for the
 * FDE, and an audit row for the buyer — success or failure.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AuditDecision, AuditEntry } from "./audit.js";
import { type AppContext, newRequestId } from "./context.js";
import { log } from "./logger.js";
import { NoCredentialError } from "./secrets.js";
import { SecretStore } from "./secrets.js";
import { StoreLinkError } from "./storelink.js";

const ACTOR = "duvo-agent";
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_THRESHOLD = 6;

function ok(text: string, data: unknown): CallToolResult {
  return { content: [{ type: "text", text: `${text}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function ceilToCasePack(units: number, casePack: number): number {
  if (casePack <= 1) return Math.max(0, units);
  return Math.ceil(units / casePack) * casePack;
}

export function buildServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "mcp-storelink", version: "1.0.0" });

  // Wraps a handler with shared logging + audit, and turns thrown errors into
  // safe, informative tool errors (never leaking a key or a stack trace).
  function handle(
    tool: string,
    fn: (args: any, requestId: string) => Promise<{ result: CallToolResult; audit: Omit<AuditEntry, "request_id" | "actor" | "tool" | "outcome"> }>,
  ) {
    return async (args: any): Promise<CallToolResult> => {
      const requestId = newRequestId();
      const started = Date.now();
      try {
        const { result, audit } = await fn(args, requestId);
        const duration_ms = Date.now() - started;
        const key_fingerprint = audit.store_id ? SecretStore.fingerprint(ctx.secrets.getKey(audit.store_id)) : undefined;
        ctx.audit.record({ request_id: requestId, actor: ACTOR, tool, outcome: "ok", duration_ms, key_fingerprint, ...audit });
        log.info("tool.ok", {
          request_id: requestId,
          tool,
          store_id: audit.store_id,
          sku: audit.sku,
          duration_ms,
          outcome: "ok",
        });
        return result;
      } catch (e) {
        const duration_ms = Date.now() - started;
        const { code, message, store_id } = classify(e);
        const key_fingerprint = store_id ? SecretStore.fingerprint(ctx.secrets.getKey(store_id)) : undefined;
        ctx.audit.record({
          request_id: requestId,
          actor: ACTOR,
          tool,
          store_id,
          decision: "blocked",
          outcome: "error",
          error_code: code,
          reason: message,
          duration_ms,
          key_fingerprint,
        });
        log.error("tool.error", {
          request_id: requestId,
          tool,
          store_id,
          duration_ms,
          outcome: "error",
          error_code: code,
        });
        return fail(message);
      }
    };
  }

  // --- list_stores ----------------------------------------------------------
  server.registerTool(
    "list_stores",
    {
      title: "List serviceable stores",
      description:
        "List the Korral stores this server can act for (i.e. has a provisioned StoreLink key). " +
        "Use this to resolve a store name to an id, or to confirm coverage before acting.",
      inputSchema: {},
    },
    handle("list_stores", async (_args, requestId) => {
      const all = await ctx.storelink.listStores(requestId);
      const provisioned = new Set(ctx.secrets.provisionedStores());
      const stores = all.filter((s) => provisioned.has(s.store_id));
      return {
        result: ok(`${stores.length} serviceable store(s).`, { stores }),
        audit: { decision: "lookup" as AuditDecision },
      };
    }),
  );

  // --- lookup_sku -----------------------------------------------------------
  server.registerTool(
    "lookup_sku",
    {
      title: "Look up a SKU",
      description:
        "Resolve a SKU to its product facts and supplier ordering rules (lead time, minimum order " +
        "quantity, case pack). Call this before raising an order so quantities respect the supplier.",
      inputSchema: { sku: z.string().describe("StoreLink SKU, e.g. 8847291") },
    },
    handle("lookup_sku", async ({ sku }, requestId) => {
      const product = await ctx.storelink.getSku(sku, requestId);
      const supplier = await ctx.storelink.getSupplier(product.supplier_id, requestId);
      const data = {
        sku: product.sku,
        name: product.name,
        category: product.category,
        unit: product.unit,
        case_pack: product.case_pack,
        supplier: {
          supplier_id: supplier.supplier_id,
          name: supplier.name,
          lead_time_days: supplier.lead_time_days,
          min_order_qty: supplier.min_order_qty,
          order_cutoff_local: supplier.order_cutoff_local,
        },
      };
      return {
        result: ok(`${product.name} — ${product.category}, supplied by ${supplier.name}.`, data),
        audit: { sku: product.sku, decision: "lookup" as AuditDecision },
      };
    }),
  );

  // --- check_stock_position -------------------------------------------------
  server.registerTool(
    "check_stock_position",
    {
      title: "Check stock position for a SKU at a store",
      description:
        "The buyer's detective work, done in one deterministic call: current on-hand vs units sold " +
        "over the recent POS window, the resulting gap, and a recommendation. " +
        "gap = units_sold_in_window - on_hand. If gap exceeds the threshold the store is on track to " +
        "stock out and replenishment is recommended. Returns a suggested order quantity that respects " +
        "the supplier's minimum and case pack — you still decide whether to raise it.",
      inputSchema: {
        store_id: z.string().describe("Store id, e.g. 47"),
        sku: z.string().describe("SKU, e.g. 8847291"),
        window_hours: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`POS look-back window in hours (default ${DEFAULT_WINDOW_HOURS}).`),
        threshold_units: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(`Gap above which replenishment is recommended (default ${DEFAULT_THRESHOLD}).`),
      },
    },
    handle("check_stock_position", async ({ store_id, sku, window_hours, threshold_units }, requestId) => {
      const windowHours = window_hours ?? DEFAULT_WINDOW_HOURS;
      const threshold = threshold_units ?? DEFAULT_THRESHOLD;
      const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

      const [inventory, pos, product] = await Promise.all([
        ctx.storelink.getInventory(store_id, sku, requestId),
        ctx.storelink.getPos(store_id, sku, since, requestId),
        ctx.storelink.getSku(sku, requestId),
      ]);
      const supplier = await ctx.storelink.getSupplier(product.supplier_id, requestId);

      const unitsSold = pos.transactions.reduce((sum, t) => sum + t.units, 0);
      const gap = unitsSold - inventory.on_hand;
      const recommend = gap > threshold;
      const suggestedQty = recommend
        ? Math.max(supplier.min_order_qty, ceilToCasePack(gap, product.case_pack))
        : 0;

      const summary = recommend
        ? `RAISE: store ${store_id} sold ${unitsSold} ${product.name} in ${windowHours}h but holds ${inventory.on_hand} on hand (gap ${gap} > ${threshold}). Suggest ordering ${suggestedQty}.`
        : `OK: store ${store_id} sold ${unitsSold} in ${windowHours}h with ${inventory.on_hand} on hand (gap ${gap} ≤ ${threshold}). No order needed.`;

      const data = {
        store_id,
        sku,
        product_name: product.name,
        on_hand: inventory.on_hand,
        units_sold: unitsSold,
        window_hours: windowHours,
        gap,
        threshold,
        recommendation: recommend ? "raise_replenishment" : "no_action",
        suggested_quantity: suggestedQty,
        case_pack: product.case_pack,
        supplier: { name: supplier.name, lead_time_days: supplier.lead_time_days, min_order_qty: supplier.min_order_qty },
        as_of: inventory.as_of,
      };

      return {
        result: ok(summary, data),
        audit: {
          store_id,
          sku,
          on_hand: inventory.on_hand,
          pos_units: unitsSold,
          window_hours: windowHours,
          gap,
          threshold,
          decision: (recommend ? "lookup" : "no_action_within_threshold") as AuditDecision,
          reason: summary,
        },
      };
    }),
  );

  // --- raise_replenishment --------------------------------------------------
  server.registerTool(
    "raise_replenishment",
    {
      title: "Raise a replenishment order",
      description:
        "Place a replenishment order at a store. Requires a short business reason — it is written to " +
        "the audit log the buyer reads. The supplier minimum order quantity is enforced by StoreLink; " +
        "if your quantity is below it the order is refused with the minimum stated. Check stock position " +
        "first.",
      inputSchema: {
        store_id: z.string().describe("Store id, e.g. 47"),
        sku: z.string().describe("SKU to order, e.g. 8847291"),
        quantity: z.number().int().positive().describe("Units to order (>0). Respect the supplier case pack/minimum."),
        reason: z.string().min(3).describe("Why this order is being raised — shown in the buyer's audit log."),
      },
    },
    handle("raise_replenishment", async ({ store_id, sku, quantity, reason }, requestId) => {
      const order = await ctx.storelink.createReplenishment(
        store_id,
        { sku, quantity, reason, requested_by: ACTOR },
        requestId,
      );
      const summary =
        `Raised order ${order.order_id}: ${quantity} × ${sku} for store ${store_id} ` +
        `(status ${order.status}, expected ${order.expected_delivery}).`;
      return {
        result: ok(summary, order),
        audit: {
          store_id,
          sku,
          quantity,
          order_id: order.order_id,
          decision: "raised_replenishment" as AuditDecision,
          reason,
        },
      };
    }),
  );

  // --- get_recent_activity --------------------------------------------------
  server.registerTool(
    "get_recent_activity",
    {
      title: "Read recent agent activity (audit log)",
      description:
        "Read back what the agent has done — the same audit trail a Korral buyer reviews. " +
        "Optionally scope to a single store. Read-only.",
      inputSchema: {
        store_id: z.string().optional().describe("Limit to one store id."),
        limit: z.number().int().positive().max(200).optional().describe("Max rows (default 20)."),
      },
    },
    handle("get_recent_activity", async ({ store_id, limit }) => {
      const rows = ctx.audit.recent({ storeId: store_id, limit });
      return {
        result: ok(`${rows.length} recent activity row(s).`, { activity: rows }),
        audit: { store_id, decision: "lookup" as AuditDecision },
      };
    }),
  );

  return server;
}

// --- error classification ---------------------------------------------------
function classify(e: unknown): { code: string; message: string; store_id?: string } {
  if (e instanceof NoCredentialError) {
    return { code: "no_credential", message: e.message, store_id: e.storeId };
  }
  if (e instanceof StoreLinkError) {
    return { code: e.code, message: e.message, store_id: e.storeId };
  }
  log.error("tool.unexpected", { error_code: "internal", msg_detail: (e as Error)?.message });
  return { code: "internal", message: "Internal error handling this request. The FDE logs have the detail." };
}

// Re-export so index.ts can fingerprint the boot key set if it wants to.
export { SecretStore };
