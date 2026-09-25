import { buildReceiptHtml, type ReceiptItem } from "./receipt";
import { buildReceiptQrPayload, generateQrDataUrl } from "./barcode";
import type { StoreRow } from "./database.types";

/**
 * Shared "build the receipt HTML + print it" entry point (Phase A item
 * 1) — used by both POSPage (right after checkout / "آخر فاتورة") and
 * SalesHistoryPage (reprint of any past sale), so both call sites stay in
 * sync with the exact same template and QR/logo/footer wiring to store
 * settings instead of drifting into two implementations.
 */

export type PrintableSale = {
  id: string;
  occurred_at: string;
  cashier_name: string | null;
  payment_method: "cash" | "card" | "credit";
  discount_amount: number;
  total_amount: number;
  refunded_amount: number;
};

export type PrintableStore = Pick<
  StoreRow,
  "id" | "store_name" | "address" | "phone" | "logo_url" | "receipt_footer" | "tax_rate" | "receipt_show_qr"
>;

export async function printSaleReceipt(params: {
  store: PrintableStore;
  sale: PrintableSale;
  items: ReceiptItem[];
  customerName?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (!window.suma?.printReceipt) {
    return { ok: false, error: "الطباعة غير متوفرة في هذه البيئة." };
  }

  let qrDataUrl: string | null = null;
  if (params.store.receipt_show_qr) {
    const payload = buildReceiptQrPayload({
      storeId: params.store.id,
      saleId: params.sale.id,
      total: params.sale.total_amount,
      occurredAt: params.sale.occurred_at,
    });
    qrDataUrl = await generateQrDataUrl(payload);
  }

  const html = buildReceiptHtml({
    storeName: params.store.store_name,
    storeAddress: params.store.address,
    storePhone: params.store.phone,
    logoUrl: params.store.logo_url,
    footer: params.store.receipt_footer,
    taxRate: Number(params.store.tax_rate ?? 0),
    saleId: params.sale.id,
    occurredAt: params.sale.occurred_at,
    cashierName: params.sale.cashier_name,
    customerName: params.customerName ?? null,
    paymentMethod: params.sale.payment_method,
    items: params.items,
    discount: Number(params.sale.discount_amount),
    total: Number(params.sale.total_amount),
    refundedAmount: Number(params.sale.refunded_amount ?? 0),
    qrDataUrl,
  });

  return window.suma.printReceipt(html);
}
