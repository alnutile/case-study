/** Shared dependencies, built once and handed to every tool. */

import { AuditStore } from "./audit.js";
import { loadConfig, type Config } from "./config.js";
import { SecretStore } from "./secrets.js";
import { StoreLinkClient } from "./storelink.js";

export interface AppContext {
  cfg: Config;
  secrets: SecretStore;
  storelink: StoreLinkClient;
  audit: AuditStore;
}

export function buildContext(): AppContext {
  const cfg = loadConfig();
  const secrets = new SecretStore(cfg);
  const storelink = new StoreLinkClient(cfg, secrets);
  const audit = new AuditStore(cfg);
  return { cfg, secrets, storelink, audit };
}

let counter = 0;
/** Short correlation id tying one tool call across logs, StoreLink, and audit. */
export function newRequestId(): string {
  counter = (counter + 1) % 1_000_000;
  return `req_${Date.now().toString(36)}_${counter.toString(36)}`;
}
