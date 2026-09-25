/**
 * Product label template (Phase A item 3) — extends ProductFichePage's
 * existing "الملصق والطباعة" section rather than replacing it: same
 * LABEL_SIZES strings, same label_size persisted on the product, only the
 * output is now a real print (offscreen window, main/printing.ts) with a
 * real scannable barcode image instead of `window.print()` over a hidden
 * on-screen div with the barcode as printed digits.
 */

const LABEL_SIZE_RE = /(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)/;

/** "80×50 مم" -> { widthMm: 80, heightMm: 50 }. Falls back to a sane
 * default (58×40, a common thermal label size) if the string doesn't
 * parse — never throws, since this only ever feeds a print dialog. */
export function parseLabelSize(label: string | null | undefined): { widthMm: number; heightMm: number } {
  const match = label ? LABEL_SIZE_RE.exec(label) : null;
  if (!match) return { widthMm: 58, heightMm: 40 };
  return { widthMm: Number(match[1]), heightMm: Number(match[2]) };
}

export type LabelData = {
  productName: string;
  price: number | null;
  barcodeValue: string | null;
  /** Pre-rendered data:image/png URL from lib/barcode.ts, or null when
   * there's no barcode value / generation failed — the label still
   * prints (name + price), just without a scan target. */
  barcodeDataUrl: string | null;
  widthMm: number;
  heightMm: number;
};

function esc(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function buildLabelHtml(data: LabelData): string {
  // Small labels (≤40mm tall) drop the barcode's own printed digits under
  // the bars — JsBarcode's displayValue text just doesn't fit legibly at
  // that size — while still keeping the bars themselves scannable.
  const compact = data.heightMm <= 40;
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<title>ملصق</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${data.widthMm}mm;
    height: ${data.heightMm}mm;
    font-family: "Tahoma", "Segoe UI", "Arial", sans-serif;
    color: #000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6mm;
    overflow: hidden;
    padding: 1mm;
  }
  .name {
    font-size: ${compact ? "9px" : "11px"};
    font-weight: 700;
    text-align: center;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .price {
    font-size: ${compact ? "12px" : "15px"};
    font-weight: 900;
    direction: ltr;
    unicode-bidi: isolate;
  }
  .barcode { max-width: 92%; ${compact ? "max-height: 40%;" : "max-height: 45%;"} }
  .barcode-fallback { font-size: 9px; direction: ltr; unicode-bidi: isolate; }
</style>
</head>
<body>
  <p class="name">${esc(data.productName)}</p>
  ${data.barcodeDataUrl ? `<img class="barcode" src="${esc(data.barcodeDataUrl)}" />` : data.barcodeValue ? `<p class="barcode-fallback">${esc(data.barcodeValue)}</p>` : ""}
  ${data.price !== null ? `<p class="price">${esc(data.price.toLocaleString("fr-FR", { maximumFractionDigits: 2 }))} دج</p>` : ""}
</body>
</html>`;
}
