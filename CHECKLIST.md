# Duvo FDE Task — Progress Checklist

Time-boxed: **1 hour**. Build a real, customer-deployable StoreLink MCP server + deployment story.
Source: [Remote Task.md](Duvo%20Case%20Study/Remote%20Task.md) · Context: [CLAUDE.md](CLAUDE.md)

**Shorthand for a win:** Solve the case + one thoughtful "nice touch" + quantify business value.

---

## Step 0 — Setup (before recording)
- [ ] Work environment ready (editor, terminal, MCP client installed)
- [ ] Screen + camera + voice recording running **before** opening the brief
- [ ] Language/framework chosen (record in CLAUDE.md working notes)

> **Build status (code complete, verified end-to-end):** mock StoreLink + MCP server both
> run; the Step-2 buyer task, Step-3 observability, and Step-4 failure paths all pass the
> smoke test; Docker image builds and serves `/healthz`. Remaining items are the **recording**,
> the **"nice touch"**, and the explicit **business-value framing** — all owned by you.

## Step 1 — The basics (agent-facing tool surface)
- [x] MCP server scaffolded and runnable — `mcp-storelink/`, builds + runs (stdio & HTTP)
- [x] Minimum buyer-agent tools exposed — `list_stores`, `lookup_sku`, `check_stock_position`, `raise_replenishment`, `get_recent_activity`
- [x] StoreLink API calls stubbed — `mock-storelink/` (FastAPI), all 8 endpoints + auth
- [x] Deliberate decisions on what **not** to expose — raw POS/inventory/supplier folded in (see MCP README)
- [x] Return shapes designed for an agent (clear, minimal, typed)
- [x] Tool naming reviewed for clarity — named for the decision, not the resource
- [x] Decisions listed briefly in the README — `mcp-storelink/README.md`

## Step 2 — Doing the job (end-to-end demo)
- [x] MCP server connected to an MCP client — `scripts/smoke.ts` drives a real stdio MCP session
- [~] Complete the buyer task **on camera**: (logic proven by smoke; camera run is yours)
  - [x] SKU 8847291 (Madeta butter 250g) at stores **47** and **102**
  - [x] Check on-hand vs. last **24h** of POS for both stores
  - [x] Raise a replenishment order where the gap **exceeds 6 units** (47 raised, 102 skipped)
- [ ] Working demo captured in the recording

## Step 3 — Observable (two readers)
- [x] FDE-at-11pm view: structured JSON logs to stderr, correlated by `request_id`, key fingerprints
- [x] Korral buyer view: SQLite audit log + `get_recent_activity` tool, plain-language decisions
- [x] Both shipped and demonstrated (visible in smoke output)

## Step 4 — Locking it down (per-store weekly-rotated key)
- [x] Secret loading implemented — `secrets.ts`, per-store via dir (prod) or inline (dev), `reload()`
- [x] Fails **safely + informatively** when a key rotates mid-request — reload+retry, else `store_key_rotated`, no order placed
- [x] Fails **safely + informatively** when asked for a store with no credentials — `no_credential`, refused before any call
- [x] Both failure paths demonstrated (no-cred shown in smoke; rotation coded + documented)

## Step 5 — Shipping it to Korral
- [x] `DEPLOYMENT.md` written
- [x] Runnable artifact (Dockerfile) — image builds + container serves `/healthz` (verified)
- [x] Covers: where it runs (inside Korral GCP, internal-only Cloud Run, no public internet)
- [x] Covers: how it gets there + frequent post-go-live updates
- [x] Covers: secret handling
- [x] Covers: who owns the pipeline (Duvo vs Korral)
- [x] Covers: how you ship a fix at 11pm
- [x] Covers: what to confirm with Korral's IT before day 1
- [x] Constraint honored: no customer data leaves Korral's GCP tenancy (+ Anthropic boundary flagged)

## The "nice touch" (pick one, not asked for)
- [ ] One thoughtful improvement built (candidates below — pick + build with you)
      - audit read-back tool already ships (`get_recent_activity`); could extend to **buyer feedback / memory**
      - **stockout ETA** is already computed; could surface a financial "revenue-at-risk" figure
- [ ] Easy to narrate in the walkthrough

## Business-value framing
- [ ] Quantified outcome in financial terms (time saved / cost reduced / revenue unlocked)
- [ ] Framed around customer KPIs, not just technical correctness

## Deliverables & wrap-up
- [x] GitHub repo with code + README + `DEPLOYMENT.md` + runnable artifact (repo not yet committed/pushed)
- [ ] ~5-min walkthrough recorded (what was built, how, why)
- [ ] Recording stopped
- [ ] Deliverables uploaded/submitted **after** stopping the recording
