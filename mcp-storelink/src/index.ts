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
