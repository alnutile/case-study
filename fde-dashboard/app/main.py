"""Korral FDE Debug Console — the 11pm-troubleshooting view (Step 3, reader A).

Reads the MCP server's read-only `/api/debug` (server status, upstream StoreLink
health, and recent tool-call traces with latency), derives operational stats, and
serves the debug HTML. Same pattern as the store dashboard: the browser only
talks to this origin, the MCP debug endpoint is called server-side.

Env:
  MCP_BASE_URL      base URL of the deployed MCP server (default http://localhost:8091)
  MCP_DEBUG_TOKEN   bearer token if the MCP's /api/debug is gated (optional)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

MCP_BASE_URL = os.environ.get("MCP_BASE_URL", "http://localhost:8091").rstrip("/")
MCP_DEBUG_TOKEN = os.environ.get("MCP_DEBUG_TOKEN")
INDEX_HTML = (Path(__file__).resolve().parent.parent / "index.html").read_text()

app = FastAPI(title="Korral FDE Debug Console")


def _pct(values: list[int], p: float) -> int | None:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return round(s[f] + (s[c] - s[f]) * (k - f))


@app.get("/healthz")
def healthz():
    return {"status": "ok", "mcp": MCP_BASE_URL}


@app.get("/", response_class=HTMLResponse)
def index():
    return INDEX_HTML


@app.get("/api/overview")
async def overview():
    headers = {"Authorization": f"Bearer {MCP_DEBUG_TOKEN}"} if MCP_DEBUG_TOKEN else {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{MCP_BASE_URL}/api/debug", headers=headers)
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        return JSONResponse(
            {"error": "mcp_unreachable", "message": str(exc), "mcp": MCP_BASE_URL},
            status_code=200,
        )

    traces = data.get("traces", []) or []
    durations = [t["duration_ms"] for t in traces if t.get("duration_ms") is not None]
    errors = [t for t in traces if t.get("outcome") == "error"]
    tools = sorted({t.get("tool") for t in traces if t.get("tool")})
    provisioned = data.get("provisioned_stores", []) or []

    # Per-store provisioning view (traces are newest-first).
    stores = []
    for s in provisioned:
        st = [t for t in traces if t.get("store_id") == s]
        last = st[0] if st else None
        stores.append(
            {
                "store_id": s,
                "last_seen": last["ts"] if last else None,
                "last_outcome": last["outcome"] if last else None,
                "calls": len(st),
                "fingerprint": next((t.get("key_fingerprint") for t in st if t.get("key_fingerprint")), None),
            }
        )

    stats = {
        "tool_calls": len(traces),
        "errors": len(errors),
        "error_rate": round(len(errors) / len(traces) * 100, 1) if traces else 0.0,
        "p50_ms": _pct(durations, 50),
        "p95_ms": _pct(durations, 95),
        "max_ms": max(durations) if durations else None,
        "tools": len(tools),
        "provisioned": len(provisioned),
        "last_activity": traces[0]["ts"] if traces else None,
    }

    return {
        "server": data.get("server"),
        "env": data.get("env"),
        "storelink_base_url": data.get("storelink_base_url"),
        "upstream": data.get("upstream"),
        "provisioned_stores": provisioned,
        "stats": stats,
        "invocations": traces[:40],
        "errors": errors[:20],
        "stores": stores,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
