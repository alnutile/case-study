"""Korral Buyer Dashboard — a thin, real-data backend.

Serves the buyer console HTML and one JSON endpoint, `/api/overview`, that pulls
**live** data from the deployed mock StoreLink, computes each watched store/SKU's
gap server-side, and returns it. Keys never reach the browser, and because the
browser only talks to this same origin there is no CORS to fight.

The "revenue at risk" figure is computed from the real gap × the SKU's POS price
— the financial framing a category buyer (and Duvo's founders) actually care about.

Env:
  STORELINK_BASE_URL  the deployed mock StoreLink (default http://localhost:8000)
  KORRAL_KEYS         {"<store_id>":"<key>"} for stores to monitor
  WATCH_SKU           SKU to monitor across stores (default 8847291)
  GAP_THRESHOLD       gap above which replenishment is recommended (default 6)
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

BASE_URL = os.environ.get("STORELINK_BASE_URL", "http://localhost:8000").rstrip("/")
WATCH_SKU = os.environ.get("WATCH_SKU", "8847291")
THRESHOLD = int(os.environ.get("GAP_THRESHOLD", "6"))

_DEFAULT_KEYS = {
    "47": "sk_live_47_a1b2c3d4",
    "102": "sk_live_102_e5f6g7h8",
    "12": "sk_live_12_i9j0k1l2",
    "150": "sk_live_150_m3n4o5p6",
}


def _load_keys() -> dict[str, str]:
    raw = os.environ.get("KORRAL_KEYS")
    if not raw:
        return dict(_DEFAULT_KEYS)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return {str(k): str(v) for k, v in parsed.items()}
    except json.JSONDecodeError:
        pass
    return dict(_DEFAULT_KEYS)


KEYS = _load_keys()
INDEX_HTML = (Path(__file__).resolve().parent.parent / "index.html").read_text()

app = FastAPI(title="Korral Buyer Dashboard")


def _ceil_case(units: int, pack: int) -> int:
    if units <= 0:
        return 0
    if not pack or pack <= 1:
        return units
    return math.ceil(units / pack) * pack


@app.get("/healthz")
def healthz():
    return {"status": "ok", "storelink": BASE_URL, "stores": sorted(KEYS, key=lambda s: int(s) if s.isdigit() else s)}


@app.get("/", response_class=HTMLResponse)
def index():
    return INDEX_HTML


@app.get("/api/overview")
async def overview():
    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows: list[dict] = []

    store_ids = sorted(KEYS, key=lambda s: int(s) if s.isdigit() else s)
    async with httpx.AsyncClient(timeout=10.0) as client:
        # SKU details once (any key works for the catalog endpoint).
        any_key = next(iter(KEYS.values()), None)
        sku_info = {}
        if any_key:
            try:
                r = await client.get(f"{BASE_URL}/v1/skus/{WATCH_SKU}", headers={"X-Korral-Store-Key": any_key})
                if r.status_code == 200:
                    sku_info = r.json()
            except httpx.HTTPError:
                pass
        case_pack = sku_info.get("case_pack", 1)
        sku_name = sku_info.get("name", WATCH_SKU)

        for store_id in store_ids:
            headers = {"X-Korral-Store-Key": KEYS[store_id]}
            try:
                inv = (await client.get(f"{BASE_URL}/v1/stores/{store_id}/inventory", params={"sku": WATCH_SKU}, headers=headers)).json()
                pos = (await client.get(f"{BASE_URL}/v1/stores/{store_id}/pos", params={"sku": WATCH_SKU, "since": since}, headers=headers)).json()
                store = (await client.get(f"{BASE_URL}/v1/stores/{store_id}", headers=headers)).json()
            except httpx.HTTPError:
                continue

            txns = pos.get("transactions", []) if isinstance(pos, dict) else []
            sold = sum(t.get("units", 0) for t in txns)
            on_hand = inv.get("on_hand", 0) if isinstance(inv, dict) else 0
            gap = sold - on_hand
            unit_price = txns[0].get("unit_price", 0.0) if txns else 0.0
            status = "critical" if gap > THRESHOLD else ("watch" if gap > 0 else "healthy")
            suggested = _ceil_case(gap, case_pack) if status == "critical" else 0
            revenue_at_risk = round(max(0, gap) * unit_price, 2)

            rows.append(
                {
                    "store_id": store_id,
                    "store_name": store.get("name") if isinstance(store, dict) else None,
                    "sku": WATCH_SKU,
                    "sku_name": sku_name,
                    "on_hand": on_hand,
                    "pos_24h": sold,
                    "gap": gap,
                    "status": status,
                    "unit_price": unit_price,
                    "revenue_at_risk": revenue_at_risk,
                    "suggested_qty": suggested,
                }
            )

    kpis = {
        "stores_monitored": len(rows),
        "stores_at_risk": sum(1 for r in rows if r["gap"] > 0),
        "critical": sum(1 for r in rows if r["status"] == "critical"),
        "watch": sum(1 for r in rows if r["status"] == "watch"),
        "revenue_at_risk": round(sum(r["revenue_at_risk"] for r in rows), 2),
    }
    return {
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "storelink": BASE_URL,
        "watch_sku": WATCH_SKU,
        "threshold": THRESHOLD,
        "kpis": kpis,
        "rows": rows,
    }
