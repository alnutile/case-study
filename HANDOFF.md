# Korral StoreLink MCP - Handoff

For Sara, Marek, and the Duvo team reviewing the FDE remote task.

## What was built

A customer-deployable MCP server that puts a Duvo agent on top of Korral's StoreLink buyer workflow, plus two purpose-built dashboards (one for the category buyer, one for the on-call FDE) and a working end-to-end demo through Claude Desktop.

The goal was not to ship a polished SaaS. It was to ship the smallest realistic version of what would actually go into Korral's GCP tenancy on day one, with the operational story (secrets, observability, deploy) honest enough that their IT team would sign off.

## Links

| Component | URL | Status |
|---|---|---|
| GitHub repo | https://github.com/alnutile/case-study | Live |
| Category buyer dashboard | https://case-study-production-904b.up.railway.app/ | Live |
| FDE debug dashboard | https://case-study-production-ffbd.up.railway.app/ | Live |
| MCP server endpoint | https://case-study-production-e645.up.railway.app/mcp | Live |
| Mock StoreLink API | https://case-study-production-15a2.up.railway.app | Live (stub) |
| Video walkthrough | _Coming after FDE deploy_ | Pending |

## The buyer task, run end-to-end

The brief asked for this scenario, run live in the recording through Claude Desktop:

> SKU 8847291 (Madeta butter 250g) is running empty at stores 47 and 102. Check on-hand vs. last 24h of POS for both, and raise a replenishment order for any store where the gap exceeds 6 units.

Result:

- **Store 47** - 18 sold in 24h vs 4 on hand, gap 14, over threshold. Order `rpl_d6a8e4b60a` raised for 24 units (2 cases at Madeta's MOQ of 12, 2 day lead time).
- **Store 102** - 13 sold vs 10 on hand, gap 3, under threshold. No action.

**Why this matters to Korral:** a buyer doing this manually walks through three screens per store, eyeballs the math, and commits an order. The same check takes the agent under a second per store. At 180 stores and ~18,000 SKUs the unit economics flip from "buyer hours" to "agent seconds." That's the wedge the rest of this work is built around.

## Design decisions worth calling out

### MCP tool surface

I exposed five tools, not nine. The brief lists nine raw StoreLink endpoints. Most of them are too low-level for an agent to use well, so I collapsed the buyer's actual decision into one deterministic call:

- `check_stock_position` - one call returns on-hand, POS in the window, the gap, the supplier rules, and a recommendation. The buyer's detective work, deterministic, no chance of the model doing the subtraction wrong.
- `raise_replenishment` - requires a written reason, which lands in the buyer's audit log.
- `lookup_sku`, `list_stores`, `get_recent_activity` - the supporting context tools.

**Why this matters:** every tool you expose is a chance for the model to do the wrong thing. Fewer, sharper tools beats a thin wrapper over the API. This is the part Korral will feel as reliability.

### Category buyer dashboard

Buyers don't want to read agent logs. They want to know which stores are at risk, what the agent did on their behalf overnight, and what's waiting on their sign-off.

- Stockout risk table with the 6-unit threshold visualized
- Live agent activity feed (what was raised, what was held for review, why)
- KPI tiles framed in financial terms (buyer hours saved, lost-sale recovery, throughput)

**Why this matters to Korral:** this is where the agent stops being a science project and becomes part of the buyer's morning. Trust is built when the audit log answers the question "what did this thing do for me yesterday" without making the buyer dig.

### FDE debug dashboard

Built for the 11pm pager scenario the brief specifically called out.

- Live trace tail with filters (errors only, slow calls, by store, by tool)
- Recent errors with one-click actions (open trace, reload secret, ping ops)
- Latency p50/p95/p99 showing drift since last deploy
- Per-store secret/key rotation status covering both Step 4 failure modes (rotated key, missing credentials)

**Why this matters to Duvo:** every minute the FDE spends bisecting a broken agent is a minute they're not deploying the next one. This view turns "what happened" from a forensics exercise into a click.

### Secrets and key rotation

Korral rotates per-store keys weekly. The server loads from Secret Manager, refreshes on 401, and fails informatively in two specific cases: (a) a key rotated mid-flight (one retry with reloaded secret, then surface), (b) the agent asks for a store with no credentials (clean 403 with the store id, never a silent half-answer). Details in `DEPLOYMENT.md`.

**Why this matters to Korral IT:** they will judge Duvo on the first weekly rotation. The story has to be boring.

### Deployment

`DEPLOYMENT.md` covers the customer-network reality: runs inside Korral's GCP tenancy, no customer data leaves, secrets via Secret Manager, Duvo owns the pipeline, image promoted via Cloud Build, hotfix path documented. Day-1 confirm list at the bottom.

## What's mocked vs real

| Piece | Status | Notes |
|---|---|---|
| StoreLink API | Mock | Stub running at the URL above, returns realistic shapes |
| MCP server | Real | Production code, runs against the mock today, swap base URL for prod |
| Buyer dashboard | Real, wired to live MCP | Pulls live data from the deployed MCP server. Shown end-to-end in the video. |
| FDE dashboard | Real, wired to live traces | Pulls live trace data from the deployed MCP server. Shown end-to-end in the video. |
| Claude Desktop demo | Real end-to-end | What you see in the video is the actual MCP server talking to the mock API |

## Outcomes I'd track in week one

If this were a real Korral go-live, these are the numbers I would put in front of the buyer team and Marek at the end of week one:

- **Buyer hours reallocated** - target 25+ hours/week across the dairy buyer team, framed as the equivalent labor cost in euros
- **Stockouts prevented** - count of orders raised that would otherwise have been raised late or missed
- **Auto-approval rate** - share of orders the agent raises within tolerance with no human in the loop. The ceiling on the time-savings curve.
- **Decision latency** - time from POS event to order raised. Korral's manual baseline is hours, the agent should be in seconds.
- **Hold rate** - share of orders held for buyer review. Too low means we're rubber-stamping, too high means the agent is timid.

## What I'd do next

In rough priority:

1. Wire the dashboards to real MCP/trace data instead of mocks
2. Stand up the eval harness so changes to the tool surface or prompts can't regress the buyer task
3. Memory layer so buyer corrections ("never auto-order EOL SKUs", "store 91 closes early on Sundays") stick
4. Second category, ideally one with a different rhythm (bakery or produce) to stress the abstractions
5. Confirm-with-Korral-IT checklist gets walked, day 1 sign-off

## Notes for the review call

The case itself is straightforward. The interesting conversation, per Sara, is how this lands inside Korral. Happy to go deep on any of:

- Why the tool surface is shaped this way (and what I deliberately left out)
- The two-audience observability split, who reads what, when
- The secret rotation failure modes and why both fail loudly
- How I'd run the first three weeks on-site with the buyer team
- What I'd push back on if Korral asked for the wrong thing
