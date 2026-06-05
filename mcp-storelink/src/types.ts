/** Shapes returned by StoreLink (mirrors the mock in ../mock-storelink). */

export interface Store {
  store_id: string;
  name: string;
  city: string;
  country: string;
  format: string;
  timezone: string;
}

export interface Sku {
  sku: string;
  name: string;
  category: string;
  supplier_id: string;
  unit: string;
  case_pack: number;
  barcode: string;
}

export interface Supplier {
  supplier_id: string;
  name: string;
  lead_time_days: number;
  min_order_qty: number;
  order_cutoff_local: string;
  timezone: string;
}

export interface Inventory {
  store_id: string;
  sku: string;
  on_hand: number;
  unit: string;
  as_of: string;
}

export interface PosTransaction {
  transaction_id: string;
  timestamp: string;
  units: number;
  unit_price: number;
  currency: string;
}

export interface PosResponse {
  store_id: string;
  sku: string;
  since: string | null;
  transactions: PosTransaction[];
}

export interface ReplenishmentOrder {
  order_id: string;
  store_id: string;
  sku: string;
  quantity: number;
  status: string;
  reason: string | null;
  requested_by: string;
  supplier_id: string;
  created_at: string;
  expected_delivery: string;
}
