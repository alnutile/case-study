# Mock StoreLink API

A faithful stand-in for Korral's **StoreLink** ordering/stock API, used to build and
demo the Duvo MCP server without touching Korral's systems. FastAPI + Uvicorn.

> In the real deployment this is replaced by the actual StoreLink host inside Korral's
> network. Only the MCP server changes its base URL — the contract here mirrors the brief.

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/v1/stores` | any valid key | List stores |
| GET | `/v1/stores/{store_id}` | store-scoped | Store details |
| GET | `/v1/stores/{store_id}/inventory?sku=` | store-scoped | Current on-hand for a SKU |
| GET | `/v1/stores/{store_id}/pos?sku=&since=` | store-scoped | POS transactions (filter by ISO `since`) |
| POST | `/v1/stores/{store_id}/replenishment` | store-scoped | Raise an order |
| GET | `/v1/stores/{store_id}/replenishment/{order_id}` | store-scoped | Order status |
| GET | `/v1/skus/{sku}` | any valid key | SKU details |
| GET | `/v1/suppliers/{supplier_id}` | any valid key | Supplier details (incl. lead time) |
| GET | `/healthz` | none | Health check |

Interactive docs at `/docs`.

## Auth

Every request sends `X-Korral-Store-Key: <key>`. Keys are **per-store** and (in real life)
rotated weekly. The mock seeds:

| Key | Store |
|-----|-------|
| `sk_live_47_a1b2c3d4` | 47 |
| `sk_live_102_e5f6g7h8` | 102 |
| `sk_live_12_i9j0k1l2` | 12 |
| `sk_live_150_m3n4o5p6` | 150 |

Override at runtime: `KORRAL_KEYS='{"sk_live_47_NEWKEY":"47"}'`.

Auth failures are distinct and machine-readable:
- `401 missing_store_key` — no header
- `401 invalid_store_key` — unknown/rotated key
- `403 store_scope_mismatch` — valid key, wrong store

## Seeded demo scenario (Step 2 of the brief)

SKU **8847291** (Madeta Butter 250g), rule: raise replenishment where
`last-24h POS sales − on-hand > 6`.

| Store | on-hand | last-24h sales | gap | action |
|-------|---------|----------------|-----|--------|
| 47 | 4 | 18 | **14** | raise |
| 102 | 10 | 13 | 3 | skip |

## Run locally

```bash
cd mock-storelink
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Smoke test:

```bash
curl -s localhost:8000/healthz
curl -s -H 'X-Korral-Store-Key: sk_live_47_a1b2c3d4' \
  'localhost:8000/v1/stores/47/inventory?sku=8847291'
```

## Run with Docker

```bash
docker build -t storelink-mock .
docker run -p 8000:8000 storelink-mock
```

## Deploy to Railway

`railway.json` builds from the `Dockerfile` and health-checks `/healthz`. Railway injects
`$PORT`. Point the service root at `mock-storelink/`, deploy, and (for the demo) set
`KORRAL_KEYS` if you want fresh keys.

> The mock is a dev/demo convenience and may live on a public PaaS. The **real** StoreLink
> and the MCP server that talks to it run **inside Korral's GCP tenancy** — see the
> top-level `DEPLOYMENT.md` (added in Step 5).
