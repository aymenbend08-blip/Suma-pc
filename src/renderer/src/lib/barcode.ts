import JsBarcode from "jsbarcode";
import QRCode from "qrcode";

/**
 * Real, scannable barcode/QR image generation (Phase A item 2) — both
 * render into a detached `<canvas>` (never attached to the visible DOM,
 * so this never flashes on screen) and come back as a `data:image/png`
 * URL, which is exactly what can be embedded directly in the generated
 * receipt/label HTML sent to the main process's offscreen print window
 * (that window loads a standalone `data:` document with no access to
 * this page's own DOM, so a live SVG/canvas node can't be handed to it —
 * only a self-contained string like a data URL can).
 */

/** CODE128 handles any digit-or-text barcode value (SUMA barcodes are
 * plain numeric strings in practice, but this isn't restricted to EAN's
 * fixed digit lengths, so a short/odd-length manual barcode still
 * renders instead of silently failing). Returns null if the value is
 * empty or JsBarcode rejects it (e.g. characters CODE128 can't encode). */
export function generateBarcodeDataUrl(value: string, opts: { widthPx?: number; heightPx?: number } = {}): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, trimmed, {
      format: "CODE128",
      width: opts.widthPx ?? 2,
      height: opts.heightPx ?? 50,
      displayValue: true,
      fontSize: 14,
      margin: 4,
    });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** QR payload for a receipt (item 1, `stores.receipt_show_qr`) — SUMA has
 * no public receipt-verification page of its own yet, so this encodes a
 * compact, self-describing reference (store + sale + total + moment)
 * rather than a URL that would 404. Good enough for "scan to confirm this
 * exact receipt against the store's records manually" today, and trivial
 * to swap for a real verification URL later without touching callers. */
export function buildReceiptQrPayload(params: {
  storeId: string;
  saleId: string;
  total: number;
  occurredAt: string;
}): string {
  return `SUMA|${params.storeId}|${params.saleId}|${params.total}|${params.occurredAt}`;
}

export async function generateQrDataUrl(text: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(text, { margin: 1, width: 160 });
  } catch {
    return null;
  }
}
