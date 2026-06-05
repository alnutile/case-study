"""Seed data for the mock StoreLink API.

This is a stand-in for Korral's real StoreLink system. The numbers are chosen so
the Step-2 buyer task in the brief has a clear, demonstrable decision:

    SKU 8847291 (Madeta Butter 250g) at stores 47 and 102.
    Rule: raise a replenishment where (last-24h POS sales - on-hand) > 6 units.

      store 47:  last-24h sales = 18  vs on-hand 4   -> gap 14  -> RAISE
      store 102: last-24h sales = 13  vs on-hand 10  -> gap 3   -> SKIP

Having one store cross the threshold and one not lets the agent show real
judgment in the demo, not blind automation.
"""

from __future__ import annotations

# --- Stores -----------------------------------------------------------------
STORES: dict[str, dict] = {
    "47": {
        "store_id": "47",
        "name": "Korral Praha – Vinohrady",
        "city": "Prague",
        "country": "CZ",
        "format": "specialty",
        "timezone": "Europe/Prague",
    },
    "102": {
        "store_id": "102",
        "name": "Korral Brno – Veveří",
        "city": "Brno",
        "country": "CZ",
        "format": "specialty",
        "timezone": "Europe/Prague",
    },
    "12": {
        "store_id": "12",
        "name": "Korral Praha – Smíchov",
        "city": "Prague",
        "country": "CZ",
        "format": "express",
        "timezone": "Europe/Prague",
    },
    "150": {
        "store_id": "150",
        "name": "Korral Wien – Mariahilf",
        "city": "Vienna",
        "country": "AT",
        "format": "specialty",
        "timezone": "Europe/Vienna",
    },
}

# --- SKUs -------------------------------------------------------------------
SKUS: dict[str, dict] = {
    "8847291": {
        "sku": "8847291",
        "name": "Madeta Butter 250g",
        "category": "Dairy & Eggs",
        "supplier_id": "sup_madeta",
        "unit": "each",
        "case_pack": 12,
        "barcode": "8594002340012",
    },
    "8847292": {
        "sku": "8847292",
        "name": "Madeta Whole Milk 1L",
        "category": "Dairy & Eggs",
        "supplier_id": "sup_madeta",
        "unit": "each",
        "case_pack": 12,
        "barcode": "8594002340029",
    },
    "9921003": {
        "sku": "9921003",
        "name": "Farmer's Free-Range Eggs 10pk",
        "category": "Dairy & Eggs",
        "supplier_id": "sup_rohlik_farm",
        "unit": "each",
        "case_pack": 6,
        "barcode": "8591234500103",
    },
}

# --- Suppliers --------------------------------------------------------------
SUPPLIERS: dict[str, dict] = {
    "sup_madeta": {
        "supplier_id": "sup_madeta",
        "name": "Madeta a.s.",
        "lead_time_days": 2,
        "min_order_qty": 12,
        "order_cutoff_local": "14:00",
        "timezone": "Europe/Prague",
    },
    "sup_rohlik_farm": {
        "supplier_id": "sup_rohlik_farm",
        "name": "Rohlík Farm Collective",
        "lead_time_days": 1,
        "min_order_qty": 6,
        "order_cutoff_local": "11:00",
        "timezone": "Europe/Prague",
    },
}

# --- On-hand inventory ------------------------------------------------------
# (store_id, sku) -> on_hand units
INVENTORY: dict[tuple[str, str], int] = {
    ("47", "8847291"): 4,
    ("102", "8847291"): 10,
    ("12", "8847291"): 22,
    ("150", "8847291"): 16,
    ("47", "8847292"): 30,
    ("102", "8847292"): 25,
}

# --- POS sales patterns -----------------------------------------------------
# (store_id, sku) -> list of (hours_ago, units) sale events, relative to "now".
# Last-24h totals: store 47 -> 18, store 102 -> 13 (see module docstring).
POS_PATTERN: dict[tuple[str, str], list[tuple[int, int]]] = {
    ("47", "8847291"): [(2, 3), (5, 4), (9, 5), (14, 2), (20, 4), (30, 5), (46, 6)],
    ("102", "8847291"): [(3, 3), (8, 4), (16, 3), (22, 3), (28, 4), (50, 5)],
    ("12", "8847291"): [(4, 2), (12, 3), (20, 2), (40, 3)],
    ("150", "8847291"): [(6, 4), (15, 5), (23, 3), (33, 4)],
}

# Unit retail price per SKU (EUR), used to populate POS lines.
UNIT_PRICE: dict[str, float] = {
    "8847291": 1.99,
    "8847292": 1.49,
    "9921003": 3.79,
}

# --- Store API keys ---------------------------------------------------------
# Real StoreLink: per-store key, rotated weekly by Korral IT. Here we seed
# defaults; override at runtime with the KORRAL_KEYS env var, e.g.
#   KORRAL_KEYS='{"sk_live_47_NEWKEY":"47"}'
DEFAULT_KEYS: dict[str, str] = {
    "sk_live_47_a1b2c3d4": "47",
    "sk_live_102_e5f6g7h8": "102",
    "sk_live_12_i9j0k1l2": "12",
    "sk_live_150_m3n4o5p6": "150",
}
