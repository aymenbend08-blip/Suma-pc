/**
 * Real, dedicated 80mm thermal receipt template (Phase A item 1) — built
 * as a fully self-contained HTML string (all styling inline, no external
 * stylesheet, images already resolved to data URLs where possible) so it
 * can be handed as-is to the main process's offscreen print window
 * (main/printing.ts), which loads it as a standalone `data:` document
 * with no access to the renderer's own app shell/fonts/assets.
 *
 * Dates use `occurredAt` (the real sale moment) throughout — never
 * "printed at" / sync time — matching the same occurred_at semantics the
 * rest of the app (record_sale, Sales History, Cash Report) already
 * standardized on.
 */

export type ReceiptItem = {
  name: string;
  /** Variant sold (sale_items.variant_name) — printed under the name. */
  variantName?: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type ReceiptData = {
  storeName: string;
  storeAddress: string | null;
  storePhone: string | null;
  /** Public URL (e.g. Supabase storage) — embedded as a plain <img src>,
   * not inlined as a data URL, since the offscreen print window can still
   * reach the network to fetch it. If it fails to load, the receipt still
   * prints fine without it (no layout dependency on it loading). */
  logoUrl: string | null;
  footer: string | null;
  taxRate: number;
  saleId: string;
  occurredAt: string;
  cashierName: string | null;
  customerName: string | null;
  paymentMethod: "cash" | "card" | "credit";
  items: ReceiptItem[];
  discount: number;
  total: number;
  /** Refunded amount already applied to this sale, if reprinting a sale
   * that was later (partially) refunded — shown as a line so a reprint
   * never looks like the original, unrefunded receipt. */
  refundedAmount?: number;
  /** Pre-rendered data:image/png URL from lib/barcode.ts, or null when
   * `receipt_show_qr` is off or generation failed. */
  qrDataUrl?: string | null;
};

const PAYMENT_LABEL: Record<ReceiptData["paymentMethod"], string> = {
  cash: "نقدًا",
  card: "بطاقة",
  credit: "كريدي (دين)",
};

function esc(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function money(n: number): string {
  return `${Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} دج`;
}

function formatMoment(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ar-DZ", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function buildReceiptHtml(data: ReceiptData): string {
  const subtotal = data.items.reduce((s, i) => s + i.lineTotal, 0);
  const itemRows = data.items
    .map(
      (i) => `
      <tr>
        <td class="name">${esc(i.name)}${i.variantName ? `<div class="variant">${esc(i.variantName)}</div>` : ""}</td>
        <td class="num">${esc(i.quantity)}</td>
        <td class="num">${esc(money(i.unitPrice))}</td>
        <td class="num strong">${esc(money(i.lineTotal))}</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<title>فاتورة</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 80mm;
    font-family: "Tahoma", "Segoe UI", "Arial", sans-serif;
    font-size: 12px;
    color: #000;
    padding: 3mm 3mm 6mm 3mm;
  }
  .center { text-align: center; }
  .logo { max-width: 22mm; max-height: 22mm; display: block; margin: 0 auto 2mm auto; }
  .store-name { font-size: 16px; font-weight: 800; margin: 0 0 1mm 0; }
  .muted { color: #333; font-size: 10px; }
  .divider { border-top: 1px dashed #000; margin: 2mm 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead th { text-align: start; border-bottom: 1px solid #000; padding: 1mm 0.5mm; font-size: 10px; }
  thead th.num, td.num { text-align: center; }
  td { padding: 1mm 0.5mm; vertical-align: top; }
  td.name { text-align: start; }
  td.name .variant { font-size: 9.5px; color: #333; }
  td.strong { font-weight: 700; }
  .totals { width: 100%; font-size: 12px; margin-top: 1mm; }
  .totals tr td { padding: 0.5mm 0; }
  .totals .label { text-align: start; color: #333; }
  .totals .value { text-align: start; direction: ltr; unicode-bidi: isolate; font-weight: 700; }
  .grand { font-size: 15px; font-weight: 900; border-top: 1px solid #000; padding-top: 1.5mm; margin-top: 1mm; }
  .meta { font-size: 10px; color: #333; margin: 0.5mm 0; }
  .qr { display: block; margin: 2mm auto 0 auto; width: 20mm; height: 20mm; }
  .footer { margin-top: 3mm; font-size: 10.5px; white-space: pre-wrap; }
  .refund-note { margin-top: 2mm; padding: 1mm; border: 1px dashed #000; font-size: 10.5px; font-weight: 700; text-align: center; }
</style>
</head>
<body>
  <div class="center">
    ${data.logoUrl ? `<img class="logo" src="${esc(data.logoUrl)}" />` : ""}
    <p class="store-name">${esc(data.storeName)}</p>
    ${data.storeAddress ? `<p class="muted">${esc(data.storeAddress)}</p>` : ""}
    ${data.storePhone ? `<p class="muted num">${esc(data.storePhone)}</p>` : ""}
  </div>

  <div class="divider"></div>

  <p class="meta">رقم الفاتورة: <span class="num">${esc(data.saleId.slice(0, 8))}</span></p>
  <p class="meta">التاريخ: <span class="num">${esc(formatMoment(data.occurredAt))}</span></p>
  ${data.cashierName ? `<p class="meta">الكاشير: ${esc(data.cashierName)}</p>` : ""}
  ${data.customerName ? `<p class="meta">الزبون: ${esc(data.customerName)}</p>` : ""}
  <p class="meta">طريقة الدفع: ${esc(PAYMENT_LABEL[data.paymentMethod])}</p>

  <div class="divider"></div>

  <table>
    <thead>
      <tr>
        <th>الصنف</th>
        <th class="num">الكمية</th>
        <th class="num">السعر</th>
        <th class="num">المجموع</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <div class="divider"></div>

  <table class="totals">
    <tr><td class="label">المجموع الفرعي</td><td class="value">${esc(money(subtotal))}</td></tr>
    ${data.discount > 0 ? `<tr><td class="label">الخصم</td><td class="value">-${esc(money(data.discount))}</td></tr>` : ""}
    <tr class="grand"><td class="label">الإجمالي</td><td class="value">${esc(money(data.total))}</td></tr>
  </table>

  ${
    data.refundedAmount && data.refundedAmount > 0
      ? `<div class="refund-note">تم استرجاع ${esc(money(data.refundedAmount))} من هذه الفاتورة</div>`
      : ""
  }

  ${data.qrDataUrl ? `<img class="qr" src="${esc(data.qrDataUrl)}" />` : ""}

  ${data.footer ? `<p class="center footer">${esc(data.footer)}</p>` : `<p class="center footer">شكرًا لزيارتكم</p>`}
</body>
</html>`;
}
