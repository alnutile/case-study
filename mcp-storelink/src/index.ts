/**
 * Entrypoint. One image, two ways in:
 *
 *   stdio  (default)  — how Claude Desktop / Claude Code launch us for the demo.
 *   http   (MCP_TRANSPORT=http) — how the server runs as a long-lived container
 *                       inside Korral's GCP, reached by the Duvo agent over the
 *                       internal network. Stateless streamable HTTP + a /healthz
 *                       probe for Cloud Run / GKE.
 */

import { createServer } from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildContext } from "./context.js";
import { log } from "./logger.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const ctx = buildContext();
  log.info("boot", {
    transport: ctx.cfg.transport,
    storelink_base_url: ctx.cfg.storelinkBaseUrl,
    provisioned_stores: ctx.secrets.provisionedStores(),
    audit_db: ctx.cfg.auditDbPath,
  });

  if (ctx.cfg.transport === "stdio") {
    const server = buildServer(ctx);
    await server.connect(new StdioServerTransport());
    log.info("ready", { transport: "stdio" });
    return;
  }

  // --- HTTP (stateless streamable) -----------------------------------------
  const http = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", provisioned_stores: ctx.secrets.provisionedStores() }));
      return;
    }

    // Read-only ops view for the FDE debug dashboard (Step 3, reader A).
    // No secrets are exposed — keys appear only as fingerprints in the audit rows.
    // Optionally gate with DEBUG_TOKEN (Bearer); left open in the demo.
    if (req.url?.startsWith("/api/debug")) {
      const token = process.env.DEBUG_TOKEN;
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const t0 = Date.now();
      let upstream: { ok: boolean; latency_ms: number } = { ok: false, latency_ms: 0 };
      try {
        const r = await fetch(new URL("/healthz", ctx.cfg.storelinkBaseUrl), { signal: AbortSignal.timeout(4000) });
        upstream = { ok: r.ok, latency_ms: Date.now() - t0 };
      } catch {
        upstream = { ok: false, latency_ms: Date.now() - t0 };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          server: { name: "mcp-storelink", version: "1.0.0" },
          env: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "local",
          storelink_base_url: ctx.cfg.storelinkBaseUrl,
          provisioned_stores: ctx.secrets.provisionedStores(),
          upstream,
          traces: ctx.audit.recent({ limit: 100 }),
        }),
      );
      return;
    }

    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }

    const body = await readJson(req);
    const server = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  http.listen(ctx.cfg.httpPort, ctx.cfg.httpHost, () => {
    log.info("ready", { transport: "http", host: ctx.cfg.httpHost, port: ctx.cfg.httpPort });
  });
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

main().catch((e) => {
  log.error("fatal", { msg_detail: (e as Error).message });
  process.exit(1);
});
