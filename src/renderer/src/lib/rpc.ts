import { supabase } from "./supabase";
import type { CustomerRow, ProductRow, PurchaseOrderRow, SaleRow, StocktakeSessionRow } from "./database.types";

/**
 * Thin, precisely-typed wrappers around the same Postgres RPCs SUMA Web
 * calls (record_sale, refund_sale, pay_customer_credit) — same names, same
 * argument shapes. The generic `Database["public"]["Functions"]` inference
 * in the installed postgrest-js is too strict for a hand-curated (not
 * generator-produced) schema subset, so the cast to `any` is isolated to
 * this one file rather than spread across call sites — the actual
 * request/response shape going over the wire is unaffected either way.
 */

export type RecordSaleItem =
  | { product_id: string; variant_id?: string | null; quantity: number; unit_price?: number }
  | { name: string; unit_price: number; quantity: number };

export type RecordSaleArgs = {
  _store_id: string;
  _items: RecordSaleItem[];
  _discount: number;
  _payment_method: "cash" | "card" | "credit";
  _customer_id?: string;
  _client_request_id?: string;
  /** The real sale moment, sent only when replaying a queued offline
   * sale — record_sale() uses it instead of its own now() so the sale
   * isn't attributed to whatever day it happened to sync on. Omitted
   * for a normal online sale, where now() is already correct. */
  _occurred_at?: string;
};

export async function recordSale(args: RecordSaleArgs) {
  return supabase.rpc("record_sale" as never, args as never) as unknown as Promise<{
    data: SaleRow | null;
    error: { message: string } | null;
  }>;
}

export type RefundSaleArgs = {
  _sale_id: string;
  _store_id: string;
  _items: Array<{ sale_item_id: string; quantity: number }>;
};

export async function refundSale(args: RefundSaleArgs) {
  return supabase.rpc("refund_sale" as never, args as never) as unknown as Promise<{
    data: SaleRow | null;
    error: { message: string } | null;
  }>;
}

export type PayCustomerCreditArgs = {
  _customer_id: string;
  _store_id: string;
  _amount: number;
  _client_request_id?: string;
};

export async function payCustomerCredit(args: PayCustomerCreditArgs) {
  return supabase.rpc("pay_customer_credit" as never, args as never) as unknown as Promise<{
    data: CustomerRow | null;
    error: { message: string } | null;
  }>;
}

/** Stock reasons mirror the stock_movements.reason CHECK constraint —
 * keep in sync with the migration if that list ever changes. */
export type StockMovementReason = "sale" | "return" | "purchase" | "manual" | "stocktake";

export type AdjustStockArgs = {
  _product_id: string;
  _store_id: string;
  _delta: number;
  _reason?: StockMovementReason;
  _reference_type?: string;
  _reference_id?: string;
  _notes?: string;
  _client_request_id?: string;
};

export async function adjustStock(args: AdjustStockArgs) {
  return supabase.rpc("adjust_stock" as never, args as never) as unknown as Promise<{
    data: ProductRow | null;
    error: { message: string } | null;
  }>;
}

export type ApplyStocktakeArgs = {
  _store_id: string;
  _lines: Array<{ product_id: string; counted_quantity: number }>;
  _notes?: string;
};

export async function applyStocktake(args: ApplyStocktakeArgs) {
  return supabase.rpc("apply_stocktake" as never, args as never) as unknown as Promise<{
    data: StocktakeSessionRow | null;
    error: { message: string } | null;
  }>;
}

export type CreatePurchaseOrderArgs = {
  _store_id: string;
  _items: Array<{ product_id?: string; product_name: string; quantity: number; unit_cost: number }>;
  _supplier_id?: string;
  _notes?: string;
};

export async function createPurchaseOrder(args: CreatePurchaseOrderArgs) {
  return supabase.rpc("create_purchase_order" as never, args as never) as unknown as Promise<{
    data: PurchaseOrderRow | null;
    error: { message: string } | null;
  }>;
}

export type ReceivePurchaseOrderArgs = {
  _po_id: string;
  _store_id: string;
  _items?: Array<{ purchase_order_item_id: string; quantity: number }>;
};

export async function receivePurchaseOrder(args: ReceivePurchaseOrderArgs) {
  return supabase.rpc("receive_purchase_order" as never, args as never) as unknown as Promise<{
    data: PurchaseOrderRow | null;
    error: { message: string } | null;
  }>;
}

export type CancelPurchaseOrderArgs = { _po_id: string; _store_id: string };

export async function cancelPurchaseOrder(args: CancelPurchaseOrderArgs) {
  return supabase.rpc("cancel_purchase_order" as never, args as never) as unknown as Promise<{
    data: PurchaseOrderRow | null;
    error: { message: string } | null;
  }>;
}
