/**
 * SUMA Web's barcode rules, dependency-free so pure modules (the importer)
 * and their tests can use them without pulling in the Supabase client.
 */

export const BARCODE_FORMAT = /^[A-Za-z0-9\-_]+$/;
export const BARCODE_MAX = 64;
/** Shortest term the server-side barcode lookups accept (SUMA Web rule). */
export const BARCODE_LOOKUP_MIN = 3;

export type BarcodeCheck = { ok: true; value: string } | { ok: false; error: string };

/** Trim + SUMA Web's schema (max 64, letters/digits/-/_). An empty value is
 * "ok" with value "" — callers decide whether a barcode is required. */
export function validateBarcode(raw: string): BarcodeCheck {
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > BARCODE_MAX) return { ok: false, error: `الباركود أطول من ${BARCODE_MAX} حرف.` };
  if (!BARCODE_FORMAT.test(value)) {
    return { ok: false, error: "الباركود يقبل الحروف اللاتينية والأرقام و - و _ فقط (بدون فراغات)." };
  }
  return { ok: true, value };
}
