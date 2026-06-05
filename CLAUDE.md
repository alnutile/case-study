# CLAUDE.md — Duvo FDE Remote Task: StoreLink MCP Server

This repo is a **time-boxed (1 hour) interview task** for a Forward Deployed Engineer
(FDE) role at **Duvo**. Source brief: [Remote Task.md](Duvo%20Case%20Study/Remote%20Task.md).
Supporting context: [role posting](Duvo%20Case%20Study/duvo-fde-role-posting.md),
[discovery call notes](Duvo%20Case%20Study/Transcript.md).

## The goal in one sentence

Ship a small but **real, customer-deployable** MCP server that lets a Duvo agent do a
grocery **category buyer's** job inside **Korral's** network — talking to their homegrown
ordering/stock tool **StoreLink** — plus a deployment story for running it in Korral's GCP.

## Customer context

- **Korral** — European specialty grocery chain. ~180 stores, ~18,000 active SKUs.
- **StoreLink** — homegrown store-ordering + stock-tracking tool. Buyers spend hours/day in
  it doing "detective work": on-hand vs POS, predicting stockouts, raising replenishment.
- Duvo signed a **pilot** to put an agent on top of this workflow.

## StoreLink API (stub these — integration plumbing is NOT what's tested)

```
GET    /v1/stores                                       List stores
GET    /v1/stores/{store_id}                            Store details
GET    /v1/stores/{store_id}/inventory?sku={sku}        Current on-hand for a SKU
GET    /v1/stores/{store_id}/pos?sku={sku}&since=...    Recent POS transactions for a SKU
POST   /v1/stores/{store_id}/replenishment              Raise a replenishment order
GET    /v1/stores/{store_id}/replenishment/{order_id}   Order status
GET    /v1/skus/{sku}                                    SKU details (name, category, supplier)
GET    /v1/suppliers/{supplier_id}                       Supplier details (incl. lead time)
```

**Auth:** `X-Korral-Store-Key: <key>` header on every request. Each key is **scoped to a
single store** and **rotated weekly** by Korral's IT.

## Deliverables (what gets submitted)

1. Screen + camera + voice recording of the session (English commentary).
2. **GitHub repo** with the code, a **`DEPLOYMENT.md`**, and a **runnable artifact**
   (Dockerfile or equivalent).
3. Final ~5-min walkthrough: what was built, how, and why.

## The 5 steps (do in order; identify the core problem, solve it, move on)

1. **The basics** — MCP server exposing the *minimum* tools a buyer-agent needs. The test is
   the **agent-facing surface**: which tools you expose, what you *don't* expose, return
   shapes, and naming. List these decisions in the README.
2. **Doing the job** — connect to an MCP client and complete this end-to-end in the recording:
   > "SKU 8847291 (Madeta butter 250g) is running empty at stores 47 and 102. Check on-hand
   > vs. last 24h of POS for both, and raise a replenishment order for any store where the
   > gap exceeds 6 units."
3. **Observable** — observability for two readers: (a) an **FDE debugging at 11pm**, and
   (b) a **Korral buyer reading the audit log** next morning to see what the agent did on
   their behalf. Decide what each needs and ship it.
4. **Locking it down** — handle the per-store weekly-rotated key. Must fail **safely and
   informatively** when: (a) a key rotates mid-request, and (b) the agent asks for a store
   you have no credentials for. Korral's IT will judge both.
5. **Shipping it to Korral** — `DEPLOYMENT.md` + runnable artifact. Constraints from IT:
   - StoreLink is **not reachable from the public internet**.
   - **No customer data may leave Korral's GCP tenancy.**
   - Updates ship **frequently** after go-live.
   - Cover: where it runs, how it gets there, secret handling, who owns the pipeline (Duvo
     vs Korral), how you ship a fix at 11pm, and what to confirm with IT before day 1.

## Key constraint

This server runs **inside the customer's network**, not on a public PaaS. Plan accordingly.

## How Duvo will judge it (guiding principles — weigh these heavily)

- **Solve the case + add one thoughtful "nice touch" not explicitly asked for + quantify
  business value.** (This is the explicit shorthand from the discovery call.)
- **Frame everything around outcomes in financial terms** — time saved, cost reduced,
  revenue unlocked (e.g. "listed 20,000 products in 2 hours for $0.50"). Not just technical
  correctness.
- **Process redesign before automation** — don't automate a broken flow.
- **Build-measure-learn; 70% working out of the gate, iterate.**
- **Agents that learn from human feedback (memory); feedback loops for validation.**
- Customer **KPIs** are the success metric.
- Tradeoffs between completeness, polish, and architecture are expected and valued.

## Working notes / decisions

_(Use this section to record tool-surface decisions, tradeoffs made under time pressure, and
the chosen "nice touch" so they're easy to narrate in the walkthrough.)_

- Language/framework: _TBD_
- MCP client used: _TBD_
- Tools exposed / deliberately not exposed: _TBD_
- The one thoughtful improvement: _TBD_
- Financial framing of the outcome: _TBD_
