import { supabase } from "./supabase";
import type {
  CustomerRow,
  ProductRow,
  PurchaseOrderRow,
  RegisterSessionRow,
  SaleRow,
  StocktakeSessionRow,
  StoreMemberRow,
} from "./database.types";

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

/**
 * Cash register (register_sessions) — same open_register()/close_register()
 * SECURITY DEFINER RPCs SUMA Web's cash-report screen already calls
 * (20260918170000_register_sessions.sql). Both are explicitly online-only:
 * a register session is a single, authoritative, cross-device fact ("is the
 * drawer open right now") that can never be queued offline without risking
 * two devices both believing they opened it — callers must check
 * `isOnline` themselves and disable the action instead of queuing it.
 *
 * NOTE (known, pre-existing server-side bug — do not "fix" client-side by
 * guessing): close_register() computes its own `expected_cash` by summing
 * `sales.created_at` (sync time) instead of `sales.occurred_at` (the real
 * sale moment), so an offline sale that synced on a later day gets
 * attributed to the wrong register session/day in that ONE stored number.
 * CashRegisterPage computes its own independent expected total keyed on
 * occurred_at (see lib/cashreport.ts) and shows both side by side so the
 * report stays self-consistent even when the RPC's own figure is skewed.
 */
export type OpenRegisterArgs = { _store_id: string; _opening_balance?: number; _notes?: string };

export async function openRegister(args: OpenRegisterArgs) {
  return supabase.rpc("open_register" as never, args as never) as unknown as Promise<{
    data: RegisterSessionRow | null;
    error: { message: string } | null;
  }>;
}

export type CloseRegisterArgs = { _session_id: string; _store_id: string; _counted_cash: number; _notes?: string };

export async function closeRegister(args: CloseRegisterArgs) {
  return supabase.rpc("close_register" as never, args as never) as unknown as Promise<{
    data: RegisterSessionRow | null;
    error: { message: string } | null;
  }>;
}

/** Adds a forgotten line item to an already-recorded sale. The RPC exists
 * and is typed/wrapped here, but NO Phase A screen calls it yet — Sales
 * History has no "add forgotten item" action (an earlier draft of this
 * comment claimed otherwise; that was inaccurate and has been corrected).
 * Kept for a future pass rather than removed, since it's a real,
 * server-verified RPC with nothing client-side left to build wrong.
 * Online-only (no offline mirror). */
export type AddItemToSaleArgs = { _sale_id: string; _store_id: string; _product_id: string; _quantity: number };

export async function addItemToSale(args: AddItemToSaleArgs) {
  return supabase.rpc("add_item_to_sale" as never, args as never) as unknown as Promise<{
    data: SaleRow | null;
    error: { message: string } | null;
  }>;
}

/**
 * Employee-account linking (Phase A item 8, completing the "add by
 * phone" flow). `link_my_employee_accounts()` (called from AuthContext
 * after sign-in) does NOT itself grant access — it only stamps
 * `pending_link_user_id`/`pending_link_requested_at` on any unlinked
 * store_members row matching the signer's phone (confirmed by reading
 * the live function body: it explicitly does not set `user_id`). An
 * admin must review and approve each request with these two RPCs before
 * that employee's `store_members.user_id` is actually set — without this
 * screen the earlier build's "add employee by phone" flow was a dead
 * end: the row would sit pending forever and the employee would sign in
 * to an empty store list.
 */
export type PendingEmployeeLinkRequest = {
  store_member_id: string;
  member_full_name: string | null;
  member_phone: string | null;
  requested_at: string;
  requester_full_name: string | null;
  requester_email: string | null;
};

export async function listPendingEmployeeLinkRequests(storeId: string) {
  return supabase.rpc("list_pending_employee_link_requests" as never, { _store_id: storeId } as never) as unknown as Promise<{
    data: PendingEmployeeLinkRequest[] | null;
    error: { message: string } | null;
  }>;
}

export type DecideEmployeeLinkRequestArgs = { _store_member_id: string; _approve: boolean };

export async function decideEmployeeLinkRequest(args: DecideEmployeeLinkRequestArgs) {
  return supabase.rpc("decide_employee_link_request" as never, args as never) as unknown as Promise<{
    data: StoreMemberRow | null;
    error: { message: string } | null;
  }>;
}
