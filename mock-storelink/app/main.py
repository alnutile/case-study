"""Mock StoreLink API for the Duvo MCP pilot.

Implements the StoreLink endpoints from the task brief with realistic shapes and
seed data, so the MCP server can be developed and demoed against a real HTTP
surface without touching Korral's systems.

    GET    /v1/stores
    GET    /v1/stores/{store_id}
    GET    /v1/stores/{store_id}/inventory?sku=...
    GET    /v1/stores/{store_id}/pos?sku=...&since=...
    POST   /v1/stores/{store_id}/replenishment
    GET    /v1/stores/{store_id}/replenishment/{order_id}
    GET    /v1/skus/{sku}
    GET    /v1/suppliers/{supplier_id}

Auth: X-Korral-Store-Key header (see auth.py).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from . import data
from .auth import require_any_key, require_store_key

app = FastAPI(
    title="StoreLink (mock)",
    version="0.1.0",
    description="Mock of Korral's StoreLink ordering/stock API for the Duvo MCP pilot.",
)

# In-memory replenishment orders. Resets on restart — fine for a mock.
ORDERS: dict[str, dict] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "bad_since", "message": "'since' must be ISO-8601, e.g. 2026-06-05T12:00:00Z."},
        ) from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _require_store(store_id: str) -> dict:
    store = data.STORES.get(store_id)
    if not store:
        raise HTTPException(404, detail={"error": "store_not_found", "message": f"No store {store_id}."})
    return store


def _require_sku(sku: str) -> dict:
    record = data.SKUS.get(sku)
    if not record:
        raise HTTPException(404, detail={"error": "sku_not_found", "message": f"No SKU {sku}."})
    return record


# --- Meta -------------------------------------------------------------------
@app.get("/", tags=["meta"])
def root():
    return {"service": "storelink-mock", "version": app.version, "docs": "/docs"}


@app.get("/healthz", tags=["meta"])
def healthz():
    return {"status": "ok", "time": _iso(_now())}


# --- Stores -----------------------------------------------------------------
@app.get("/v1/stores", tags=["stores"])
def list_stores(_key_store: str = Depends(require_any_key)):
    return {"stores": list(data.STORES.values())}


@app.get("/v1/stores/{store_id}", tags=["stores"])
def get_store(store_id: str, _: str = Depends(require_store_key)):
    return _require_store(store_id)


@app.get("/v1/stores/{store_id}/inventory", tags=["stores"])
def get_inventory(
    store_id: str,
    sku: str = Query(...),
    _: str = Depends(require_store_key),
):
    _require_store(store_id)
    record = _require_sku(sku)
    on_hand = data.INVENTORY.get((store_id, sku), 0)
    return {
        "store_id": store_id,
        "sku": sku,
        "on_hand": on_hand,
        "unit": record["unit"],
        "as_of": _iso(_now()),
    }


@app.get("/v1/stores/{store_id}/pos", tags=["stores"])
def get_pos(
    store_id: str,
    sku: str = Query(...),
    since: str | None = Query(default=None),
    _: str = Depends(require_store_key),
):
    _require_store(store_id)
    _require_sku(sku)
    now = _now()
    since_dt = _parse_iso(since) if since else None

    transactions = []
    for hours_ago, units in data.POS_PATTERN.get((store_id, sku), []):
        ts = now - timedelta(hours=hours_ago)
        if since_dt and ts < since_dt:
            continue
        transactions.append(
            {
                "transaction_id": f"pos_{store_id}_{sku}_{hours_ago}h",
                "timestamp": _iso(ts),
                "units": units,
                "unit_price": data.UNIT_PRICE.get(sku, 0.0),
                "currency": "EUR",
            }
        )
    transactions.sort(key=lambda t: t["timestamp"], reverse=True)
    return {
        "store_id": store_id,
        "sku": sku,
        "since": since,
        "transactions": transactions,
    }


# --- Replenishment ----------------------------------------------------------
class ReplenishmentRequest(BaseModel):
    sku: str
    quantity: int = Field(gt=0, description="Units to order. Must be > 0.")
    reason: str | None = Field(default=None, description="Human-readable justification (shows in audit log).")
    requested_by: str = Field(default="duvo-agent", description="Who/what raised the order.")


@app.post("/v1/stores/{store_id}/replenishment", status_code=201, tags=["replenishment"])
def create_replenishment(
    store_id: str,
    body: ReplenishmentRequest,
    _: str = Depends(require_store_key),
):
    _require_store(store_id)
    sku = _require_sku(body.sku)
    supplier = data.SUPPLIERS[sku["supplier_id"]]

    if body.quantity < supplier["min_order_qty"]:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "below_min_order_qty",
                "message": f"Supplier {supplier['name']} requires a minimum order of {supplier['min_order_qty']} units.",
                "min_order_qty": supplier["min_order_qty"],
            },
        )

    now = _now()
    order_id = f"rpl_{uuid.uuid4().hex[:10]}"
    order = {
        "order_id": order_id,
        "store_id": store_id,
        "sku": body.sku,
        "quantity": body.quantity,
        "status": "submitted",
        "reason": body.reason,
        "requested_by": body.requested_by,
        "supplier_id": supplier["supplier_id"],
        "created_at": _iso(now),
        "expected_delivery": _iso(now + timedelta(days=supplier["lead_time_days"])),
    }
    ORDERS[order_id] = order
    return order


@app.get("/v1/stores/{store_id}/replenishment/{order_id}", tags=["replenishment"])
def get_replenishment(
    store_id: str,
    order_id: str,
    _: str = Depends(require_store_key),
):
    _require_store(store_id)
    order = ORDERS.get(order_id)
    if not order or order["store_id"] != store_id:
        raise HTTPException(
            404,
            detail={"error": "order_not_found", "message": f"No order {order_id} for store {store_id}."},
        )
    return order


# --- Catalog (cross-store) --------------------------------------------------
@app.get("/v1/skus/{sku}", tags=["catalog"])
def get_sku(sku: str, _key_store: str = Depends(require_any_key)):
    return _require_sku(sku)


@app.get("/v1/suppliers/{supplier_id}", tags=["catalog"])
def get_supplier(supplier_id: str, _key_store: str = Depends(require_any_key)):
    supplier = data.SUPPLIERS.get(supplier_id)
    if not supplier:
        raise HTTPException(404, detail={"error": "supplier_not_found", "message": f"No supplier {supplier_id}."})
    return supplier
