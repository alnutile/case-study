# DEPLOYMENT.md — StoreLink MCP server at Korral

How the StoreLink MCP server runs and is operated **inside Korral's GCP tenancy**. Written for
Korral IT and the Duvo FDE on call.

The constraints from Korral IT drive every choice below:

1. **StoreLink is not reachable from the public internet.**
2. **No customer data may leave Korral's GCP tenancy.**
3. **We will ship updates frequently after go-live.**

---

## 1. Where it runs

```
            Korral GCP project (europe-west3)
 ┌───────────────────────────────────────────────────────────────┐
 │  Serverless VPC / VPC connector                                │
 │                                                                │
 │   Duvo agent runtime ──MCP/HTTP──▶  StoreLink MCP server       │
 │   (internal ingress)               (Cloud Run, internal-only)  │
 │                                        │        │              │
 │                                        │        ▼              │
 │                                        │   audit.db (volume)   │
 │                                        ▼                       │
 │                              StoreLink API (internal host)     │
 │                                        ▲                       │
 │   Secret Manager ──mounted files──────┘ (per-store keys)       │
 │   Cloud Logging  ◀── structured stderr logs                    │
 └───────────────────────────────────────────────────────────────┘
        no public ingress · egress to StoreLink only
```

- **Platform: Cloud Run** (service, **internal ingress only**) on a **Serverless VPC connector** so it
  can reach StoreLink's internal host but is unreachable from the internet. GKE is a fine alternative
  if Korral already standardizes on it — the container is identical.
- Runs in **HTTP transport** mode (`MCP_TRANSPORT=http`), exposing `POST /mcp` (streamable MCP) and
  `GET /healthz`. The Duvo agent reaches it over the **internal** network only.
- `STORELINK_BASE_URL` points at StoreLink's internal address. Region pinned to Korral's
  (`europe-west3`) so nothing leaves the tenancy.

## 2. How it gets there (artifact + pipeline)

The **image** is the only thing that crosses the Duvo→Korral boundary — it contains **code, no
customer data**.

1. **Duvo CI** (on merge to `main`): build the image, run the smoke test, push to **Korral's
   Artifact Registry** (`europe-west3-docker.pkg.dev/korral-prod/duvo/storelink-mcp:<git-sha>`) via a
   service account Korral grants `artifactregistry.writer` on that one repo.
2. **Deploy into Korral's project** with an immutable tag:
   ```bash
   gcloud run deploy storelink-mcp \
     --project korral-prod --region europe-west3 \
     --image europe-west3-docker.pkg.dev/korral-prod/duvo/storelink-mcp:$GIT_SHA \
     --ingress internal --vpc-connector korral-vpc \
     --no-allow-unauthenticated \
     --set-env-vars STORELINK_BASE_URL=http://storelink.internal:8000,MCP_TRANSPORT=http \
     --update-secrets /var/run/secrets/korral=korral-store-keys:latest \
     --set-env-vars KORRAL_KEYS_DIR=/var/run/secrets/korral
   ```
3. Cloud Run keeps every revision → **traffic-split rollout** and **one-command rollback**.

## 3. Secrets & weekly rotation (Step 4 in production)

- Each store's StoreLink key is a **GCP Secret Manager** secret, **mounted as a file** into the
  container at `KORRAL_KEYS_DIR` (filename = `store_id`, contents = key). No keys in env, image, or
  source.
- **Korral IT owns the key values and the weekly rotation.** Rotation = add a new secret version.
- **Rotation while a request is in flight:** StoreLink returns `401 invalid_store_key`; the server
  **reloads the mounted secret once and retries** with the fresh key. If the new key hasn't landed
  yet it fails closed with `store_key_rotated` — **no order is placed** and the message tells IT
  exactly what to publish. (See `mcp-storelink/src/storelink.ts`.)
- **Store with no key:** refused **before any network call** (`no_credential`), naming the stores the
  server *can* serve. Provisioning a new store = add one secret + grant access; no code change.
- Keys appear in logs only as a `key_fingerprint` (SHA-256 prefix), never in clear.

## 4. Who owns what

| Area | Owner |
|------|-------|
| App code, image, IaC, smoke/CI | **Duvo** |
| GCP project, VPC, internal DNS, Cloud Run/GKE | **Korral IT** |
| Secret **values** + weekly rotation | **Korral IT** |
| Secret **layout** + reload behavior | **Duvo** (agreed with IT) |
| Deploy approval to prod | **Korral IT** (Duvo proposes, Korral merges/approves) |
| On-call for the MCP server | **Duvo FDE**, escalate to Korral IT for infra/network |

Duvo owns the outcome; Korral owns the tenancy. Deploys run **inside Korral's project** so no data
or control plane leaves it.

## 5. Shipping a fix at 11pm

1. Patch + PR; CI builds and **runs the smoke test** against a mock StoreLink.
2. `gcloud run deploy …:<new-sha>` → new revision, route **10% → 100%** while watching `/healthz`
   and error logs (filter `level=error` by `request_id`).
3. **Bad?** `gcloud run services update-traffic storelink-mcp --to-revisions <prev>=100` — instant
   rollback, no rebuild. Revisions are immutable, so rollback is deterministic.
4. The change is **code only**; secrets and the audit DB are untouched by a deploy.

## 6. No customer data leaves the tenancy

- Image = code only. **Audit DB** is a SQLite file on a Cloud Run volume / GKE PVC **inside the
  project**. **Logs** go to Korral's **Cloud Logging** in-region.
- ⚠️ **One data flow to settle explicitly:** the Duvo *agent* runs on Anthropic's enterprise
  platform, so StoreLink data the agent reasons over leaves the tenancy *to the model* even though
  this server never does. That must be covered by Duvo's Anthropic enterprise agreement
  (zero-retention / no-training) and **signed off by Korral** — it's a contract boundary, not a
  server setting. Flagging it rather than hiding it.

## 7. Confirm with Korral IT before day 1

- [ ] StoreLink internal **host:port + TLS** the server should call, and that the VPC connector has
      **egress** to it.
- [ ] **Platform**: Cloud Run (internal ingress) vs existing GKE.
- [ ] **Artifact Registry** repo + a deploy **service account** for Duvo CI (scoped to one repo).
- [ ] **Secret Manager** layout (one secret per store vs one map), the **rotation mechanism**, and
      confirmation that mounted secrets update without a redeploy.
- [ ] How the **Duvo agent authenticates** to the MCP endpoint over the internal network (mTLS / IAM
      / header) and the internal DNS name.
- [ ] **Cloud Logging** sink + retention, and **audit DB** persistence/backup expectations.
- [ ] **Data-residency region** for all of the above (default `europe-west3`).
- [ ] Sign-off on the **Anthropic data-processing boundary** in §6.

---

### TL;DR
One container, internal-only Cloud Run inside Korral's VPC, talking to StoreLink over the internal
network. Per-store keys from Secret Manager, hot-reloaded on rotation, fail-closed. Image crosses the
boundary; **data never does** (modulo the Anthropic boundary in §6). Ship fixes by rolling a new
Cloud Run revision; roll back by shifting traffic.
