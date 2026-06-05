# StoreLink MCP Server

The MCP server that lets a Duvo agent do a Korral category buyer's job against **StoreLink**:
read a store's stock position, decide whether it will run out, and raise replenishment —
with a full audit trail and per-store credential handling.

TypeScript · [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol) · stdio + HTTP transports.

> Talks to StoreLink over HTTP. In dev that's the [mock](../mock-storelink); in production it's
> the real StoreLink host inside Korral's network. Only `STORELINK_BASE_URL` changes.

---

## The agent-facing surface (Step 1 decisions)

The point of Step 1 is **what the agent sees**, not the plumbing. We expose **5 job-shaped tools**,
not StoreLink's 8 raw REST endpoints:

| Tool | Purpose | Returns |
|------|---------|---------|
| `list_stores` | Which stores this server can act for | Only stores we hold a key for (doubles as a capability check) |
| `lookup_sku` | Product + supplier facts in one call | name, category, case pack, supplier lead time & min order qty |
| `check_stock_position` | The buyer's detective work, server-side | on-hand, units sold in window, **gap**, recommendation, suggested qty |
| `raise_replenishment` | The one state-changing action | created order (id, status, expected delivery) |
| `get_recent_activity` | Read back the audit log (buyer's view) | recent agent actions, optionally per store |

### What we deliberately do **not** expose, and why

- **Raw POS transactions** — folded into `check_stock_position`. Handing an agent hundreds of raw
  till lines invites wrong arithmetic and burns tokens; the gap is computed **server-side and
  deterministically** (`gap = units_sold_in_window − on_hand`).
- **Raw inventory / store / supplier endpoints** — folded into the tools above so the agent makes
  **one intentful call**, not four chatty ones.
- **Any write that skips the audit trail** — `raise_replenishment` is the only mutation and it
  **requires a `reason`**, written verbatim to the buyer's audit log.

### Shape & naming choices

- Tools are named for the **decision** (`check_stock_position`), not the resource (`getInventory`).
- `check_stock_position` returns a **recommendation + suggested quantity already rounded to the
  supplier's case pack and floored at their minimum order qty** — so the number is something
  StoreLink will actually accept. The agent still decides whether to raise it.
- `window_hours` (default 24) and `threshold_units` (default 6) are **parameters**, so policy lives
  with the agent/task, not hard-coded in the server.
- Errors come back as tool results with `isError: true` and a machine-readable message — never a
  thrown stack trace, never a leaked key.

---

## Configuration (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `STORELINK_BASE_URL` | `http://localhost:8000` | StoreLink host (the mock in dev) |
| `STORELINK_TIMEOUT_MS` | `5000` | Per-request timeout |
| `MCP_TRANSPORT` | `stdio` | `stdio` for local clients, `http` for the container |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | `0.0.0.0` / `8080` | HTTP transport bind (ignored for stdio) |
| `AUDIT_DB_PATH` | `./data/audit.db` | SQLite audit log — a file inside the tenancy |
| `KORRAL_KEYS_DIR` | — | Dir of per-store key files (`<store_id>` → key). **Production shape.** |
| `KORRAL_KEYS` | — | Inline `{"<store_id>":"<key>"}` for local dev only |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

Secrets are read **only** in `secrets.ts`, referenced in logs only by `fingerprint()`, never by
value. See [DEPLOYMENT.md](../DEPLOYMENT.md) for the rotation story (Step 4).

---

## Run locally

```bash
npm install
npm run build

# 1) start the mock StoreLink (separate terminal)
#    (cd ../mock-storelink && .venv/bin/uvicorn app.main:app --port 8000)

# 2) end-to-end smoke = the Step-2 buyer task over a real MCP session
KORRAL_KEYS='{"47":"sk_live_47_a1b2c3d4","102":"sk_live_102_e5f6g7h8"}' npm run smoke
```

### Connect to Claude Desktop / Claude Code (stdio)

```jsonc
// claude_desktop_config.json → "mcpServers"
{
  "storelink": {
    "command": "node",
    "args": ["/absolute/path/to/mcp-storelink/dist/index.js"],
    "env": {
      "STORELINK_BASE_URL": "http://localhost:8000",
      "KORRAL_KEYS": "{\"47\":\"sk_live_47_a1b2c3d4\",\"102\":\"sk_live_102_e5f6g7h8\"}"
    }
  }
}
```

Then ask the agent the Step-2 task verbatim:

> "SKU 8847291 (Madeta butter 250g) is running empty at stores 47 and 102. Check on-hand vs. last
> 24h of POS for both, and raise a replenishment order for any store where the gap exceeds 6 units."

### Run as an HTTP service (how it runs in Korral's GCP)

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=8080 node dist/index.js
# POST /mcp  (streamable MCP)   ·   GET /healthz  (liveness)
```

---

## Observability (Step 3)

Two readers, two surfaces:

- **FDE at 11pm** → structured JSON logs on **stderr**, one line per event, correlated by
  `request_id` across tool → StoreLink call → outcome, with latency and `error_code`. Secrets appear
  only as `key_fingerprint`.
- **Korral buyer next morning** → the **audit log** (`get_recent_activity` / the SQLite DB): one
  plain-language row per consequential action — what the agent did, the numbers it decided on, and
  why. `decision` ∈ `lookup` · `no_action_within_threshold` · `raised_replenishment` · `blocked`.

> On stdio, stdout is the MCP protocol channel — logs **must** go to stderr or they corrupt it.

## Failure modes (Step 4)

- **Key rotates mid-request** → StoreLink answers `401 invalid_store_key`; we reload secrets from
  source once and retry with the fresh key. If it still fails we raise `KeyRotatedError` — **no order
  placed**, message tells IT the new key hasn't reached this server yet.
- **Store with no credential** → refused **before any network call** with `no_credential`, naming the
  stores we *can* serve.

See [DEPLOYMENT.md](../DEPLOYMENT.md) for the full deployment + secrets operating story.
