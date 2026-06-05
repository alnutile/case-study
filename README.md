# Korral StoreLink MCP Server

A custom MCP server that lets a Duvo agent do a Korral category buyer's job: check on-hand vs POS, decide whether a store is heading toward a stockout, and raise replenishment orders against the StoreLink system of record.

- **Handoff doc with URLs, deployed dashboards, and walkthrough:** see [`HANDOFF.md`](./HANDOFF.md)
- **Operational story (where it runs, secrets, deploy, hotfix path):** see [`DEPLOYMENT.md`](./DEPLOYMENT.md)

## Design decisions

Per Step 1 of the brief, this section is the short version of the choices I made and the reasoning behind them. The full review-call narrative lives in `HANDOFF.md`.

### Five tools, not nine

The StoreLink API exposes nine raw endpoints. I exposed five MCP tools. The endpoints I deliberately did not surface (raw `GET /inventory`, raw `GET /pos`, raw supplier lookup) are still reachable through composite tools that do the buyer's actual job.

| Tool | What it does | Why it exists |
|---|---|---|
| `check_stock_position` | One call returns on-hand, POS in the window, the gap, supplier rules, and a recommendation. | Collapses the buyer's detective work into one deterministic call. The model never does the math. |
| `raise_replenishment` | Places an order. Requires a written `reason`. StoreLink enforces supplier MOQ. | The `reason` field lands in the audit log the buyer reads next morning. |
| `lookup_sku` | Resolves a SKU to product facts and supplier ordering rules. | Lets the agent respect case pack and lead time before ordering. |
| `list_stores` | Lists stores the server has credentials for. | Useful for cross-store sweeps; only returns stores this server can act on. |
| `get_recent_activity` | Recent agent activity at a store. | Cheap context for follow-up tasks and audit. |

### What I deliberately left off

- **No raw `GET /inventory` or `GET /pos`** tool. The agent doesn't need them separately. Giving the model both invites it to do its own subtraction and get the threshold logic wrong on edge cases.
- **No `cancel_replenishment` or `edit_replenishment`** tool. Cancellation is a buyer decision with downstream implications (supplier penalty, transit). I'd add it deliberately after Korral confirms the policy, not on day one.
- **No bulk/multi-store action tool.** Sweeps are done by the agent looping `check_stock_position` per store. Keeps the audit log per-decision instead of per-batch.

### Shapes and naming

- All tools return both a one-line human summary **and** a structured JSON block. The summary is for the agent's reasoning and the audit log. The JSON is for downstream automation.
- `recommendation` is an enum (`raise_replenishment`, `no_action`), not free text. Cuts ambiguity.
- `as_of` timestamps on every read. The buyer needs to know the freshness, not just the value.
- Tool names are verb-led and read like buyer actions, not API endpoints. The agent picks them more reliably.

### Observability (Step 3)

Two audiences, two views:

- **FDE at 11pm:** structured traces with `trace_id`, tool, store, SKU, latency, status, token use, full request/response payloads. Filterable by store, tool, error. See the FDE dashboard linked in `HANDOFF.md`.
- **Buyer in the morning:** human-readable activity log. Every `raise_replenishment` shows the `reason` field. Held orders surface with the rule that held them. See the buyer dashboard linked in `HANDOFF.md`.

### Secrets (Step 4)

Per-store API keys load from Secret Manager at request time, with two failure modes handled explicitly:

- **Key rotated mid-flight.** Server hits 401, reloads from Secret Manager once, retries. If still 401, surface to the caller with the store id and key fingerprint so IT can confirm rotation.
- **No credentials for a requested store.** Clean 403 with the store id named. Never a silent half-answer.

Details and the day-1 IT confirm list are in `DEPLOYMENT.md`.

## Run it

```bash
# Local
docker build -t storelink-mcp .
docker run -p 8080:8080 \
  -e STORELINK_BASE_URL=https://case-study-production-15a2.up.railway.app \
  -e SECRETS_BACKEND=env \
  storelink-mcp

# MCP endpoint
https://case-study-production-e645.up.railway.app/mcp
```

For the customer-network deployment story (GCP tenancy, Secret Manager, image promotion, hotfix path), see `DEPLOYMENT.md`.

## Repo layout

```
.
├── README.md            # This file: design decisions (Step 1)
├── HANDOFF.md           # URLs, deployed dashboards, walkthrough notes
├── DEPLOYMENT.md        # Customer-network deployment (Step 5)
├── Dockerfile           # Runnable artifact
└── src/                 # MCP server source
```
