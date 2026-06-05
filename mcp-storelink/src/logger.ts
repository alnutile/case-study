/**
 * Structured logging — the FDE-at-11pm view (Step 3, reader A).
 *
 * One JSON object per line to stderr (stdout is reserved for the stdio MCP
 * transport, so logs must never go there). Every line carries a request_id so an
 * FDE can `grep` a single agent action across tool call -> StoreLink call ->
 * outcome. Keys are stable and machine-parseable for Cloud Logging.
 *
 * Secrets never appear here. Keys are referenced only by fingerprint (see
 * secrets.ts), never by value.
 */

import { loadConfig } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[loadConfig().logLevel] ?? LEVELS.info;

export interface LogFields {
  request_id?: string;
  tool?: string;
  store_id?: string;
  sku?: string;
  key_fingerprint?: string;
  duration_ms?: number;
  outcome?: "ok" | "error";
  error_code?: string;
  [key: string]: unknown;
}

function emit(level: Level, msg: string, fields: LogFields = {}): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    service: "mcp-storelink",
    ...fields,
  });
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: LogFields) => emit("debug", msg, f),
  info: (msg: string, f?: LogFields) => emit("info", msg, f),
  warn: (msg: string, f?: LogFields) => emit("warn", msg, f),
  error: (msg: string, f?: LogFields) => emit("error", msg, f),
};
