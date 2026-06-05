/**
 * Typed HTTP client for StoreLink, and the home of the two Step-4 failure
 * stories.
 *
 *  (a) Key rotates mid-request: StoreLink answers 401 invalid_store_key. We
 *      reload secrets from source once (a rotation may already be on disk),
 *      retry with the fresh key, and only if that also fails do we surface a
 *      clear, non-leaking error telling the agent/IT the key needs reloading.
 *
 *  (b) Store we hold no key for: we never make the call — SecretStore raises
 *      NoCredentialError up front, naming the stores we *can* serve.
 *
 * Errors are normalised to StoreLinkError so the tool layer and audit log get a
 * stable `code` (store_not_found, sku_not_found, below_min_order_qty, ...)
 * rather than raw HTTP.
 */

import type { Config } from "./config.js";
import { log } from "./logger.js";
import { NoCredentialError, SecretStore } from "./secrets.js";
import type {
  Inventory,
  PosResponse,
  ReplenishmentOrder,
  Sku,
  Store,
  Supplier,
} from "./types.js";

export class StoreLinkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly storeId?: string,
  ) {
    super(message);
    this.name = "StoreLinkError";
  }
}

/** Surfaced when a key still fails after a reload+retry — the rotation case. */
export class KeyRotatedError extends StoreLinkError {
  constructor(storeId: string, fingerprint: string) {
    super(
      "store_key_rotated",
      `StoreLink rejected this server's key for store ${storeId} (fingerprint ${fingerprint}) ` +
        `even after reloading secrets. The weekly key rotation has likely landed but the new ` +
        `key has not reached this server yet. No order was placed. Ask Korral IT to confirm the ` +
        `current key for store ${storeId} has been published to this server's secret source.`,
      401,
      storeId,
    );
    this.name = "KeyRotatedError";
  }
}

interface CallOpts {
  method?: "GET" | "POST";
  storeId?: string; // store-scoped call -> use that store's key
  body?: unknown;
  query?: Record<string, string | undefined>;
  requestId: string;
}

export class StoreLinkClient {
  constructor(
    private readonly cfg: Config,
    private readonly secrets: SecretStore,
  ) {}

  // --- Public, tool-facing methods -----------------------------------------

  async listStores(requestId: string): Promise<Store[]> {
    const data = await this.call<{ stores: Store[] }>("/v1/stores", { requestId, storeId: this.anyStore() });
    return data.stores;
  }

  async getSku(sku: string, requestId: string): Promise<Sku> {
    return this.call<Sku>(`/v1/skus/${encodeURIComponent(sku)}`, { requestId, storeId: this.anyStore() });
  }

  async getSupplier(supplierId: string, requestId: string): Promise<Supplier> {
    return this.call<Supplier>(`/v1/suppliers/${encodeURIComponent(supplierId)}`, {
      requestId,
      storeId: this.anyStore(),
    });
  }

  async getInventory(storeId: string, sku: string, requestId: string): Promise<Inventory> {
    return this.call<Inventory>(`/v1/stores/${storeId}/inventory`, { requestId, storeId, query: { sku } });
  }

  async getPos(storeId: string, sku: string, since: string, requestId: string): Promise<PosResponse> {
    return this.call<PosResponse>(`/v1/stores/${storeId}/pos`, { requestId, storeId, query: { sku, since } });
  }

  async createReplenishment(
    storeId: string,
    body: { sku: string; quantity: number; reason: string; requested_by: string },
    requestId: string,
  ): Promise<ReplenishmentOrder> {
    return this.call<ReplenishmentOrder>(`/v1/stores/${storeId}/replenishment`, {
      requestId,
      storeId,
      method: "POST",
      body,
    });
  }

  async getReplenishment(storeId: string, orderId: string, requestId: string): Promise<ReplenishmentOrder> {
    return this.call<ReplenishmentOrder>(`/v1/stores/${storeId}/replenishment/${orderId}`, { requestId, storeId });
  }

  // --- Internals ------------------------------------------------------------

  /** Cross-store endpoints still need *a* valid key; use any one we hold. */
  private anyStore(): string {
    const stores = this.secrets.provisionedStores();
    if (stores.length === 0) {
      throw new NoCredentialError("(any)", []);
    }
    return stores[0];
  }

  private async call<T>(path: string, opts: CallOpts): Promise<T> {
    const storeId = opts.storeId!;
    let key = this.secrets.getKey(storeId);
    if (!key) {
      // Step 4 (b): refuse before any network call.
      throw new NoCredentialError(storeId, this.secrets.provisionedStores());
    }

    let attempt = 0;
    // One retry budget, reserved for the rotation-mid-request case.
    while (true) {
      attempt++;
      const res = await this.fetch(path, key, opts);

      if (res.ok) {
        return (await res.json()) as T;
      }

      const err = await this.toError(res, storeId);

      // Step 4 (a): key looks rotated. Reload secrets once and retry with fresh key.
      if (err.code === "invalid_store_key" && attempt === 1) {
        log.warn("storelink.key_rejected_reloading", {
          request_id: opts.requestId,
          store_id: storeId,
          key_fingerprint: SecretStore.fingerprint(key),
        });
        this.secrets.reload();
        const fresh = this.secrets.getKey(storeId);
        if (fresh && fresh !== key) {
          key = fresh;
          continue; // retry with the rotated-in key
        }
        throw new KeyRotatedError(storeId, SecretStore.fingerprint(key));
      }

      throw err;
    }
  }

  private async fetch(path: string, key: string, opts: CallOpts): Promise<Response> {
    const url = new URL(path, this.cfg.storelinkBaseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.storelinkTimeoutMs);
    try {
      return await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "X-Korral-Store-Key": key,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new StoreLinkError(
        "storelink_unreachable",
        `Could not reach StoreLink at ${this.cfg.storelinkBaseUrl}: ${(e as Error).message}. ` +
          `If this server just started, confirm STORELINK_BASE_URL and network egress inside Korral's VPC.`,
        503,
        opts.storeId,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async toError(res: Response, storeId: string): Promise<StoreLinkError> {
    let code = `http_${res.status}`;
    let message = res.statusText;
    try {
      const body = (await res.json()) as { detail?: { error?: string; message?: string } };
      if (body.detail?.error) code = body.detail.error;
      if (body.detail?.message) message = body.detail.message;
    } catch {
      /* non-JSON error body; keep defaults */
    }
    return new StoreLinkError(code, message, res.status, storeId);
  }
}
