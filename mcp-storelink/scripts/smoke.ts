/**
 * End-to-end smoke test == the Step-2 buyer task, run through the real MCP
 * protocol (spawns the server over stdio, like Claude Desktop would).
 *
 *   "SKU 8847291 (Madeta butter 250g) is running empty at stores 47 and 102.
 *    Check on-hand vs last 24h of POS for both, and raise a replenishment order
 *    for any store where the gap exceeds 6 units."
 *
 * Also exercises the Step-4 failure path (a store we hold no key for).
 *
 * Prereq: the mock StoreLink must be running at STORELINK_BASE_URL (default
 * http://localhost:8000). Run:  (cd ../mock-storelink && uvicorn app.main:app)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BASE_URL = process.env.STORELINK_BASE_URL ?? "http://localhost:8000";
const KEYS = '{"47":"sk_live_47_a1b2c3d4","102":"sk_live_102_e5f6g7h8"}';
const SKU = "8847291";

function textOf(result: any): string {
  return (result.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

async function main() {
  // Fail fast with a friendly message if the mock isn't up.
  try {
    await fetch(new URL("/healthz", BASE_URL));
  } catch {
    console.error(`\n✗ Mock StoreLink is not reachable at ${BASE_URL}.`);
    console.error(`  Start it:  (cd ../mock-storelink && uvicorn app.main:app)\n`);
    process.exit(2);
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    env: {
      ...process.env,
      STORELINK_BASE_URL: BASE_URL,
      KORRAL_KEYS: KEYS,
      AUDIT_DB_PATH: "./data/smoke-audit.db",
      LOG_LEVEL: "warn",
    },
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("Tools exposed:", tools.tools.map((t) => t.name).join(", "), "\n");

  const THRESHOLD = 6;
  for (const store of ["47", "102"]) {
    const check = await client.callTool({
      name: "check_stock_position",
      arguments: { store_id: store, sku: SKU, window_hours: 24, threshold_units: THRESHOLD },
    });
    const data = JSON.parse(textOf(check).split("```json")[1].split("```")[0]);
    console.log(`store ${store}: on_hand=${data.on_hand} sold24h=${data.units_sold} gap=${data.gap} -> ${data.recommendation}`);

    if (data.recommendation === "raise_replenishment") {
      const order = await client.callTool({
        name: "raise_replenishment",
        arguments: {
          store_id: store,
          sku: SKU,
          quantity: data.suggested_quantity,
          reason: `24h sales ${data.units_sold} vs on-hand ${data.on_hand}; gap ${data.gap} > ${THRESHOLD}.`,
        },
      });
      console.log("   " + textOf(order).split("\n")[0]);
    } else {
      console.log("   (within threshold — no order)");
    }
  }

  // Step 4 (b): a store we hold no credential for must fail safely.
  console.log("\nStep-4 check — store 999 (no key provisioned):");
  const denied = await client.callTool({ name: "list_stores", arguments: {} });
  console.log("   serviceable:", textOf(denied).split("```json")[1] ? JSON.parse(textOf(denied).split("```json")[1].split("```")[0]).stores.map((s: any) => s.store_id).join(",") : "?");
  const noCred = await client.callTool({
    name: "check_stock_position",
    arguments: { store_id: "999", sku: SKU },
  });
  console.log("   " + textOf(noCred).split("\n")[0], noCred.isError ? "[isError ✓]" : "[NOT flagged ✗]");

  console.log("\nAudit log (buyer view):");
  const activity = await client.callTool({ name: "get_recent_activity", arguments: { limit: 10 } });
  const rows = JSON.parse(textOf(activity).split("```json")[1].split("```")[0]).activity;
  for (const r of rows.reverse()) {
    console.log(`   [${r.decision}] ${r.tool} store=${r.store_id ?? "-"} sku=${r.sku ?? "-"} gap=${r.gap ?? "-"} order=${r.order_id ?? "-"}`);
  }

  await client.close();
  console.log("\n✓ Smoke test complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
