"""Auth for the mock StoreLink API.

StoreLink authenticates with a per-store key sent on every request via the
``X-Korral-Store-Key`` header. Each key is scoped to a single store and rotated
weekly by Korral's IT.

Two dependencies:
  - ``require_store_key`` enforces that the presented key is valid AND scoped to
    the store in the path (used by all store-scoped endpoints).
  - ``require_any_key`` only checks the key is valid (used by cross-store
    endpoints like listing stores, SKU details, supplier details — a per-store
    key cannot be scoped to "all stores").

The distinct error bodies matter: the MCP server (and Korral IT reading logs)
must be able to tell "no key" from "rotated/invalid key" from "wrong store".
"""

from __future__ import annotations

import json
import os
import sys

from fastapi import Header, HTTPException, Path

from .data import DEFAULT_KEYS


def _load_keys() -> dict[str, str]:
    raw = os.environ.get("KORRAL_KEYS")
    if not raw:
        return dict(DEFAULT_KEYS)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # A bad value must never crash boot — fall back to built-in demo keys.
        print("WARN: KORRAL_KEYS is not valid JSON; using built-in demo keys", file=sys.stderr)
        return dict(DEFAULT_KEYS)
    if not isinstance(parsed, dict):
        print(
            'WARN: KORRAL_KEYS must be a JSON object like {"<key>": "<store_id>"}; '
            "using built-in demo keys",
            file=sys.stderr,
        )
        return dict(DEFAULT_KEYS)
    return {str(k): str(v) for k, v in parsed.items()}


# Loaded once at import. In the mock this is the whole "secret store".
KEYS: dict[str, str] = _load_keys()


def _missing_key() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={
            "error": "missing_store_key",
            "message": "Every StoreLink request must send the X-Korral-Store-Key header.",
        },
    )


def _invalid_key() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={
            "error": "invalid_store_key",
            "message": "Unknown or rotated store key. Reload this week's key from Korral IT.",
        },
    )


async def require_store_key(
    store_id: str = Path(...),
    x_korral_store_key: str | None = Header(default=None),
) -> str:
    """Validate the key and that it is scoped to ``store_id``."""
    if not x_korral_store_key:
        raise _missing_key()
    mapped = KEYS.get(x_korral_store_key)
    if mapped is None:
        raise _invalid_key()
    if mapped != store_id:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "store_scope_mismatch",
                "message": f"This key is scoped to store {mapped}, not store {store_id}.",
                "key_store_id": mapped,
                "requested_store_id": store_id,
            },
        )
    return store_id


async def require_any_key(
    x_korral_store_key: str | None = Header(default=None),
) -> str:
    """Validate the key for a cross-store endpoint. Returns the key's store_id."""
    if not x_korral_store_key:
        raise _missing_key()
    mapped = KEYS.get(x_korral_store_key)
    if mapped is None:
        raise _invalid_key()
    return mapped
