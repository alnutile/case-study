/**
 * The audit log — the Korral-buyer-next-morning view (Step 3, reader B).
 *
 * Where the structured logs (logger.ts) are for an FDE debugging a failure, this
 * is the business record a category buyer reads to answer "what did the agent do
 * on my behalf, and why?". Every consequential action lands here as one row, in
 * plain business language, with the numbers the decision was based on.
 *
 * Storage is a single SQLite file (node:sqlite, no native deps). It lives on a
 * volume inside Korral's tenancy and never leaves it — which is exactly what
 * Step 5's "no customer data leaves the GCP tenancy" constraint requires.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Config } from "./config.js";

export type AuditDecision =
  | "raised_replenishment"
  | "no_action_within_threshold"
  | "blocked"
  | "lookup";

export interface AuditEntry {
  request_id: string;
  actor: string; // who the agent acted as, e.g. "duvo-agent"
  tool: string;
  store_id?: string;
  sku?: string;
  on_hand?: number;
  pos_units?: number; // units sold in the window
  window_hours?: number;
  gap?: number;
  threshold?: number;
  decision: AuditDecision;
  order_id?: string;
  quantity?: number;
  reason?: string; // why the agent did it — buyer-facing
  outcome: "ok" | "error";
  error_code?: string;
  key_fingerprint?: string;
}

export interface AuditRow extends AuditEntry {
  id: number;
  ts: string;
}

export class AuditStore {
  private readonly db: DatabaseSync;

  constructor(cfg: Config) {
    mkdirSync(dirname(cfg.auditDbPath), { recursive: true });
    this.db = new DatabaseSync(cfg.auditDbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL,
        request_id      TEXT NOT NULL,
        actor           TEXT NOT NULL,
        tool            TEXT NOT NULL,
        store_id        TEXT,
        sku             TEXT,
        on_hand         INTEGER,
        pos_units       INTEGER,
        window_hours    INTEGER,
        gap             INTEGER,
        threshold       INTEGER,
        decision        TEXT NOT NULL,
        order_id        TEXT,
        quantity        INTEGER,
        reason          TEXT,
        outcome         TEXT NOT NULL,
        error_code      TEXT,
        key_fingerprint TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_store ON audit_log(store_id, ts);
    `);
  }

  record(entry: AuditEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (
        ts, request_id, actor, tool, store_id, sku, on_hand, pos_units,
        window_hours, gap, threshold, decision, order_id, quantity, reason,
        outcome, error_code, key_fingerprint
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    stmt.run(
      new Date().toISOString(),
      entry.request_id,
      entry.actor,
      entry.tool,
      entry.store_id ?? null,
      entry.sku ?? null,
      entry.on_hand ?? null,
      entry.pos_units ?? null,
      entry.window_hours ?? null,
      entry.gap ?? null,
      entry.threshold ?? null,
      entry.decision,
      entry.order_id ?? null,
      entry.quantity ?? null,
      entry.reason ?? null,
      entry.outcome,
      entry.error_code ?? null,
      entry.key_fingerprint ?? null,
    );
  }

  /** Recent activity, newest first — optionally scoped to one store. */
  recent(opts: { storeId?: string; limit?: number } = {}): AuditRow[] {
    const limit = Math.min(opts.limit ?? 20, 200);
    const rows = opts.storeId
      ? this.db
          .prepare(`SELECT * FROM audit_log WHERE store_id = ? ORDER BY id DESC LIMIT ?`)
          .all(opts.storeId, limit)
      : this.db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit);
    return rows as unknown as AuditRow[];
  }
}
