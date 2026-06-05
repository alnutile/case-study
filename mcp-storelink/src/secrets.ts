/**
 * Per-store secret handling (Step 4).
 *
 * StoreLink uses one API key per store, rotated weekly by Korral's IT. This
 * module is the only place keys live in memory, and the only place they are
 * read from their source. Two source shapes are supported:
 *
 *   KORRAL_KEYS_DIR  — a directory mounted from a secret manager. One file per
 *                      store, filename = store_id, contents = the key. This is
 *                      the production shape in GCP (Secret Manager -> mounted
 *                      volume / CSI). Re-reading the dir picks up a rotation
 *                      with no redeploy.
 *
 *   KORRAL_KEYS      — inline JSON {"<store_id>":"<key>"} for local dev only.
 *
 * Design choices that matter to Korral IT:
 *   - Keys are referenced in logs only by `fingerprint()` (a salted-free SHA-256
 *     prefix), never by value.
 *   - `reload()` re-reads the source on demand, so a mid-request rotation can be
 *     recovered without a restart (see storelink.ts retry path).
 *   - `provisionedStores()` lets us refuse a store we have no key for *before*
 *     making any network call, with a clear message.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.js";
import { log } from "./logger.js";

export class SecretStore {
  private keys: Map<string, string> = new Map();

  constructor(private readonly cfg: Config) {
    this.reload();
  }

  /** Re-read keys from the configured source. Safe to call on every rotation. */
  reload(): void {
    const next = new Map<string, string>();

    if (this.cfg.korralKeysDir) {
      for (const file of readdirSync(this.cfg.korralKeysDir)) {
        if (file.startsWith(".")) continue; // skip ..data symlinks from k8s/CSI mounts
        const key = readFileSync(join(this.cfg.korralKeysDir, file), "utf8").trim();
        if (key) next.set(file.trim(), key);
      }
    } else if (this.cfg.korralKeysInline) {
      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(this.cfg.korralKeysInline);
      } catch {
        throw new Error('KORRAL_KEYS must be JSON: {"<store_id>":"<key>"}');
      }
      for (const [storeId, key] of Object.entries(parsed)) {
        if (key) next.set(String(storeId), String(key));
      }
    }

    this.keys = next;
    log.info("secrets.loaded", {
      provisioned_stores: this.provisionedStores(),
      source: this.cfg.korralKeysDir ? "dir" : this.cfg.korralKeysInline ? "inline" : "none",
    });
  }

  /** Store IDs we currently hold a key for. */
  provisionedStores(): string[] {
    return [...this.keys.keys()].sort();
  }

  hasKey(storeId: string): boolean {
    return this.keys.has(storeId);
  }

  /** The key for a store, or undefined if we hold none. */
  getKey(storeId: string): string | undefined {
    return this.keys.get(storeId);
  }

  /**
   * A short, non-reversible reference to a key, for logs and audit rows. Lets an
   * FDE confirm "the key changed" across a rotation without ever seeing the key.
   */
  static fingerprint(key: string | undefined): string {
    if (!key) return "none";
    return "sk:" + createHash("sha256").update(key).digest("hex").slice(0, 8);
  }
}

/** Raised before any network call when we hold no key for the requested store. */
export class NoCredentialError extends Error {
  constructor(public readonly storeId: string, public readonly provisioned: string[]) {
    super(
      `No StoreLink credential is provisioned for store ${storeId}. ` +
        `This server can currently act for stores: ${provisioned.join(", ") || "(none)"}. ` +
        `Ask Korral IT to provision a key for store ${storeId}.`,
    );
    this.name = "NoCredentialError";
  }
}
