/**
 * Runtime configuration, read once from the environment.
 *
 * Everything that changes between Korral's environments (the StoreLink base URL,
 * where secrets live, where the audit DB lives, the transport) is an env var so
 * the same image ships unchanged from a laptop to Korral's GCP.
 */

export type Transport = "stdio" | "http";

export interface Config {
  /** Base URL of StoreLink inside Korral's network (the mock during dev). */
  storelinkBaseUrl: string;
  /** Per-request timeout talking to StoreLink, ms. */
  storelinkTimeoutMs: number;
  /** How the MCP client reaches us: stdio for local demo, http in the container. */
  transport: Transport;
  /** HTTP transport bind host/port (ignored for stdio). */
  httpHost: string;
  httpPort: number;
  /** Path to the SQLite audit DB. A file inside the container/volume — never leaves the tenancy. */
  auditDbPath: string;
  /** Inline secrets JSON: {"<store_key>":"<store_id>"} — dev convenience. */
  korralKeysInline?: string;
  /** Directory of per-store key files: <store_id> -> file contents. Preferred in GCP. */
  korralKeysDir?: string;
  /** Log verbosity for the FDE-facing structured logs. */
  logLevel: "debug" | "info" | "warn" | "error";
}

function num(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const transport = (env.MCP_TRANSPORT === "http" ? "http" : "stdio") as Transport;
  return {
    storelinkBaseUrl: env.STORELINK_BASE_URL ?? "http://localhost:8000",
    storelinkTimeoutMs: num(env.STORELINK_TIMEOUT_MS, 5000),
    transport,
    httpHost: env.MCP_HTTP_HOST ?? "0.0.0.0",
    httpPort: num(env.MCP_HTTP_PORT, 8080),
    auditDbPath: env.AUDIT_DB_PATH ?? "./data/audit.db",
    korralKeysInline: env.KORRAL_KEYS,
    korralKeysDir: env.KORRAL_KEYS_DIR,
    logLevel: (env.LOG_LEVEL as Config["logLevel"]) ?? "info",
  };
}
