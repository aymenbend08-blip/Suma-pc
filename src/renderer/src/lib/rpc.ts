import { supabase } from "./supabase";
import type { CustomerRow, SaleRow } from "./database.types";

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
