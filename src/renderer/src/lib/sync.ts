import { supabase } from "./supabase";
import { localDb } from "./localdb";
import {
  recordSale,
  payCustomerCredit,
  adjustStock,
  type RecordSaleArgs,
  type PayCustomerCreditArgs,
  type AdjustStockArgs,
} from "./rpc";
import { isNetworkError } from "./net";
import type { CategoryRow, CustomerRow, ProductBarcodeRow, ProductRow, ProductVariantRow } from "./database.types";

/**
 * Full reference-table pull for one store — no incremental "since X"
 * tracking (see the comment in main/db.ts for why: SUMA's per-store data
 * volume is small enough that a full re-pull every cycle is simpler and
 * safe, and it needs no new Supabase columns). Called on store selection
 * and on a timer while online; also doubles as the app's "are we
 * actually online" probe — a network-shaped failure here is what flips
 * the UI's connectivity indicator to offline.
 */
const HYDRATE_PAGE = 1000;

/**
 * Every row of one store-scoped table, fetched in 1000-row pages ordered by
 * id. PostgREST caps an un-ranged select at its max_rows (1000 on Supabase
 * by default) without any error, so a single select("*") silently
 * truncated the mirror for a store past 1000 products — which the Excel
 * importer makes an everyday size, and POS reads ONLY from this mirror.
 */
async function fetchAllForStore<T>(
  table: "products" | "product_barcodes" | "product_variants" | "categories" | "customers",
  storeId: string,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  for (let from = 0; ; from += HYDRATE_PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .eq("store_id", storeId)
      .order("id", { ascending: true })
      .range(from, from + HYDRATE_PAGE - 1);
    if (error) return { data: [], error };
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < HYDRATE_PAGE) break;
  }
  return { data: all, error: null };
}

export async function hydrate(storeId: string, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const [storesRes, membersRes, productsRes, barcodesRes, variantsRes, categoriesRes, customersRes] = await Promise.all([
      supabase.from("stores").select("*").order("created_at", { ascending: true }),
      supabase.from("store_members").select("*").eq("user_id", userId),
      fetchAllForStore<ProductRow>("products", storeId),
      fetchAllForStore<ProductBarcodeRow>("product_barcodes", storeId),
      fetchAllForStore<ProductVariantRow>("product_variants", storeId),
      fetchAllForStore<CategoryRow>("categories", storeId),
      fetchAllForStore<CustomerRow>("customers", storeId),
    ]);
    for (const res of [storesRes, membersRes, productsRes, barcodesRes, variantsRes, categoriesRes, customersRes]) {
      if (res.error) throw new Error(res.error.message);
    }

    localDb.replaceStores(storesRes.data ?? []);
    localDb.replaceStoreMembers(userId, membersRes.data ?? []);
    localDb.replaceProducts(storeId, productsRes.data ?? []);
    localDb.replaceProductBarcodes(storeId, barcodesRes.data ?? []);
    localDb.replaceProductVariants(storeId, variantsRes.data ?? []);
    localDb.replaceCategories(storeId, categoriesRes.data ?? []);
    localDb.replaceCustomers(storeId, customersRes.data ?? []);

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type DrainResult = { synced: number; failed: number; stoppedOffline: boolean };

/**
 * Replays queued offline operations against the exact same RPCs SUMA Web
 * uses, in the order they were created. Stops at the first network-shaped
 * failure (we've gone offline again mid-drain) rather than burning
 * through the rest of the queue against a dead connection; a genuine
 * business rejection (e.g. insufficient stock by the time this synced)
 * only fails that one item and moves on — it's surfaced to the owner,
 * never silently dropped.
 */
export async function drainQueue(): Promise<DrainResult> {
  const pending = await localDb.listPendingSync();
  let synced = 0;
  let failed = 0;

  for (const item of pending) {
    const payload = JSON.parse(item.payload) as unknown;
    let result: { data: unknown; error: { message: string } | null };

    if (item.operation_type === "record_sale") {
      result = await recordSale(payload as RecordSaleArgs);
    } else if (item.operation_type === "pay_customer_credit") {
      result = await payCustomerCredit(payload as PayCustomerCreditArgs);
    } else if (item.operation_type === "adjust_stock") {
      result = await adjustStock(payload as AdjustStockArgs);
    } else {
      await localDb.markSyncFailed(item.id, `نوع عملية غير معروف: ${item.operation_type}`);
      failed += 1;
      continue;
    }

    if (!result.error) {
      await localDb.markSyncDone(item.id);
      synced += 1;
      continue;
    }

    if (isNetworkError(result.error.message)) {
      await localDb.markSyncRetry(item.id, result.error.message);
      return { synced, failed, stoppedOffline: true };
    }

    await localDb.markSyncFailed(item.id, result.error.message);
    failed += 1;
  }

  return { synced, failed, stoppedOffline: false };
}
