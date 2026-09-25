import type { ImportDuplicateStrategy, ImportProductRow, ImportProductsResult, ImportRowStatus } from "./database.types";
import { BARCODE_FORMAT, BARCODE_MAX } from "./barcodeRules";

/**
 * Pure logic of the Excel/CSV product importer — no React, no Supabase, no
 * SheetJS — so every rule here is unit-tested (productImport.test.ts).
 * Header synonyms, number parsing, total-row detection and the template
 * are SUMA Web's (products.import.tsx), so a file prepared for one app
 * imports the same way in the other.
 */

// ---- Target fields & column mapping -------------------------------------

export type ImportField =
  | "name"
  | "barcode"
  | "internal_code"
  | "selling_price"
  | "purchase_price"
  | "stock_quantity"
  | "unit"
  | "category_name"
  | "low_stock_threshold"
  | "points_reward"
  | "expiry_date"
  | "description";

export const IMPORT_FIELDS: Array<{ key: ImportField; label: string; required?: boolean }> = [
  { key: "name", label: "اسم المنتج", required: true },
  { key: "barcode", label: "Barcode الأساسي" },
  { key: "internal_code", label: "الكود الداخلي" },
  { key: "selling_price", label: "سعر البيع" },
  { key: "purchase_price", label: "سعر الشراء" },
  { key: "stock_quantity", label: "المخزون" },
  { key: "unit", label: "الوحدة" },
  { key: "category_name", label: "التصنيف" },
  { key: "low_stock_threshold", label: "حد تنبيه المخزون" },
  { key: "points_reward", label: "نقاط الولاء" },
  { key: "expiry_date", label: "تاريخ الصلاحية" },
  { key: "description", label: "الوصف" },
];

/** Synonyms per field, most specific first, already in normalizeHeader()'s
 * shape. SUMA Web's lists for its eight fields, plus PC's four extras. */
export const FIELD_GUESSES: Record<ImportField, string[]> = {
  name: [
    "name", "product name", "product", "article", "produit", "nom",
    "désignation", "designation", "libellé", "libelle",
    "اسم المنتج", "المنتج",
  ],
  category_name: [
    "category", "category name", "catégorie", "categorie", "famille", "classification",
    "التصنيف", "الفئة",
  ],
  selling_price: [
    "prix vente detaillant", "prix vente détaillant", "prix detaillant",
    "prix vente détail", "prix vente detail",
    "selling price", "sale price", "retail price",
    "prix vente", "prix de vente", "pv",
    "سعر البيع",
  ],
  purchase_price: [
    "purchase price", "cost price", "cost", "buy price", "buying price",
    "prix d'achat", "prix achat", "pa",
    "سعر الشراء", "ثمن الشراء", "تكلفة",
  ],
  stock_quantity: [
    "stock", "stock quantity", "quantity", "qty", "qté", "quantité", "quantite", "qte",
    "stock actuel",
    "المخزون", "الكمية",
  ],
  barcode: [
    "barcode", "bar code", "code barre", "code barres",
    "cb", "ean", "ean13", "upc", "gtin",
    "الباركود", "باركود", "رمز المنتج",
  ],
  internal_code: [
    "internal code", "code", "reference", "référence", "réf", "ref",
    "product code", "item code", "sku",
    "المرجع", "كود المنتج",
  ],
  unit: ["unit", "unite", "unité"],
  low_stock_threshold: ["low stock threshold", "حد المخزون", "min stock", "stock min"],
  points_reward: ["points reward", "نقاط", "points"],
  expiry_date: ["expiry date", "تاريخ الصلاحية", "expiry", "date d'expiration"],
  description: ["الوصف", "description"],
};

/** trim, lowercase, curly quotes -> ', - _ . -> space, collapse spaces. */
export function normalizeHeader(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[-_.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ColumnMapping = Partial<Record<ImportField, string>>;

/** For each field in IMPORT_FIELDS order, walk its synonyms in order and take
 * the first header that matches exactly (after normalization). A column is
 * never assigned to two fields. */
export function guessMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map((raw) => ({ raw, norm: normalizeHeader(raw) }));
  const used = new Set<string>();
  const mapping: ColumnMapping = {};
  for (const { key } of IMPORT_FIELDS) {
    for (const guess of FIELD_GUESSES[key]) {
      const hit = normalized.find((h) => h.norm === guess && !used.has(h.raw));
      if (hit) {
        mapping[key] = hit.raw;
        used.add(hit.raw);
        break;
      }
    }
  }
  return mapping;
}

const EXTRA_BARCODE_HEADER = /barcode|bar code|code[\s-]?barr|\bcb\b|\bean\b|gtin|upc|باركود|extra_barcodes/i;

/** Every barcode-looking column other than the one mapped as the main
 * barcode ("Barcode 2", "EAN 3", "extra_barcodes"...). */
export function guessExtraBarcodeColumns(headers: string[], mainBarcodeColumn: string | undefined): string[] {
  return headers.filter((h) => h !== mainBarcodeColumn && EXTRA_BARCODE_HEADER.test(h));
}

// ---- Cell parsing -------------------------------------------------------

function toStr(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/**
 * SUMA Web's parseNumberLoose: strips currency labels/letters, keeps a
 * leading '-', drops spaces; when both ',' and '.' appear the LAST one is
 * the decimal separator; with one separator type, more than two groups
 * means thousands grouping, and a single separator followed by exactly 3
 * digits (not all zeros) is a thousands separator — anything else is a
 * decimal point. Returns null when nothing numeric can be read.
 */
export function parseNumberLoose(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (s === "") return null;
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  s = s.replace(/[^\d.,\s]/g, "").trim();
  if (s === "") return null;
  s = s.replace(/\s+/g, "");
  if (s === "") return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    s = resolveSingleSeparator(s, ",");
  } else if (hasDot) {
    s = resolveSingleSeparator(s, ".");
  }
  if (!/\d/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function resolveSingleSeparator(s: string, sep: "," | "."): string {
  const parts = s.split(sep);
  if (parts.length === 1) return s;
  if (parts.length > 2) return parts.join("");
  const trailing = parts[1];
  const looksLikeThousands = trailing.length === 3 && /[1-9]/.test(trailing);
  return looksLikeThousands ? parts.join("") : `${parts[0]}.${trailing}`;
}

export type CellParse<T> = { kind: "empty" } | { kind: "ok"; value: T } | { kind: "invalid" };

/** A blank cell is "empty" (field not provided); a non-blank cell that
 * can't be read as a number is "invalid" — never silently nulled. */
export function parseNumberCell(raw: unknown): CellParse<number> {
  if (toStr(raw).trim() === "") return { kind: "empty" };
  const n = parseNumberLoose(raw);
  return n === null ? { kind: "invalid" } : { kind: "ok", value: n };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoIfValid(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Excel's 1900 date system (with its fake 1900-02-29): serial 1 = 1900-01-01,
 * serial 60 is the phantom leap day, so day 0 is effectively 1899-12-30. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const whole = Math.floor(serial);
  if (whole === 60) return null; // 1900-02-29 never existed
  const base = whole < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const ms = base + whole * 86_400_000;
  const d = new Date(ms);
  return isoIfValid(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Accepts YYYY-MM-DD (or YYYY/MM/DD), DD/MM/YYYY (also - or . separated,
 * 2-digit years read as 20xx) and Excel serial numbers. */
export function parseDateCell(raw: unknown): CellParse<string> {
  if (typeof raw === "number") {
    const iso = excelSerialToIso(raw);
    return iso ? { kind: "ok", value: iso } : { kind: "invalid" };
  }
  const s = toStr(raw).trim();
  if (!s) return { kind: "empty" };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const iso = isoIfValid(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { kind: "ok", value: iso } : { kind: "invalid" };
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const iso = isoIfValid(year, Number(m[2]), Number(m[1]));
    return iso ? { kind: "ok", value: iso } : { kind: "invalid" };
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const iso = excelSerialToIso(Number(s));
    return iso ? { kind: "ok", value: iso } : { kind: "invalid" };
  }
  return { kind: "invalid" };
}

/**
 * Excel's General format shows a long integer typed as a number (the usual
 * way a barcode column ends up) in scientific notation — "6.13E+12" — and
 * that displayed text is what sheet_to_json(raw: false) returns. For every
 * numeric cell whose display uses an exponent but whose value is an exact
 * integer, restore the full digits as the display text. Values beyond 2^53
 * already lost digits inside the file and are left alone (they then fail
 * barcode validation visibly instead of importing a wrong code).
 * Mutates a SheetJS worksheet object in place; returns the cells fixed.
 */
export function restoreScientificIntegers(sheet: Record<string, unknown>): number {
  let fixed = 0;
  for (const [address, value] of Object.entries(sheet)) {
    if (address.startsWith("!") || !value || typeof value !== "object") continue;
    const cell = value as { t?: string; v?: unknown; w?: string };
    if (cell.t !== "n" || typeof cell.v !== "number" || typeof cell.w !== "string") continue;
    if (!/e[+-]?\d/i.test(cell.w)) continue;
    if (!Number.isInteger(cell.v) || Math.abs(cell.v) > Number.MAX_SAFE_INTEGER) continue;
    cell.w = String(cell.v);
    fixed += 1;
  }
  return fixed;
}

export function isValidBarcode(code: string): boolean {
  return code.length > 0 && code.length <= BARCODE_MAX && BARCODE_FORMAT.test(code);
}

/** Rows that are clearly not products (totals some POS exports append). */
export const TOTAL_ROW_PATTERN = /^(total|totaux|grand[\s-]?total|sous[\s-]?total|الإجمالي|إجمالي|مجموع|المجموع)$/i;

// ---- Row preparation (client pre-validation) ----------------------------

export const LIMITS = {
  name: 160,
  internalCode: 40,
  unit: 30,
  category: 80,
  description: 1000,
  price: 99_999_999,
  points: 10_000,
  extraBarcodes: 30,
} as const;

export type PreparedRow = {
  /** Spreadsheet line (header is line 1). */
  line: number;
  payload: ImportProductRow;
  /** Blocking problems found client-side — the row is never sent. */
  errors: string[];
  /** Non-blocking notes (e.g. an invalid extra barcode that was dropped). */
  notes: string[];
  /** Other spreadsheet lines folded into this product (same name) — see
   * mergeSameNameRows. Their barcodes became this row's extra barcodes. */
  mergedLines?: number[];
};

export type PrepareResult = {
  rows: PreparedRow[];
  /** Rows with an empty name (not counted as products at all). */
  skippedEmpty: number;
  /** "Total"-like rows, reported as skipped. */
  skippedTotals: Array<{ line: number; name: string }>;
};

/**
 * Turns raw sheet rows (sheet_to_json with defval "" and raw false) into
 * ImportProductRow payloads plus per-row client errors. Only fields that
 * are mapped AND non-blank are included, so an update never blanks a
 * field the file didn't provide; numbers are sent as numbers.
 */
export function prepareRows(
  rawRows: Array<Record<string, unknown>>,
  mapping: ColumnMapping,
  extraBarcodeColumns: string[],
): PrepareResult {
  const rows: PreparedRow[] = [];
  let skippedEmpty = 0;
  const skippedTotals: Array<{ line: number; name: string }> = [];
  const cell = (r: Record<string, unknown>, field: ImportField): unknown => {
    const col = mapping[field];
    return col ? r[col] : undefined;
  };

  rawRows.forEach((r, idx) => {
    // SheetJS tags each row object with its 0-based sheet row (non-
    // enumerable __rowNum__); blank rows are dropped by sheet_to_json, so
    // idx + 2 is only a fallback for rows built by hand.
    const rowNum = (r as { __rowNum__?: unknown }).__rowNum__;
    const line = typeof rowNum === "number" ? rowNum + 1 : idx + 2;
    const name = toStr(cell(r, "name")).replace(/\s+/g, " ").trim();
    if (!name) {
      // A fully blank line is just spacing; a line with data but no name is
      // still skipped (the server requires a name) and counted.
      skippedEmpty += 1;
      return;
    }
    if (TOTAL_ROW_PATTERN.test(name)) {
      skippedTotals.push({ line, name });
      return;
    }

    const errors: string[] = [];
    const notes: string[] = [];
    const payload: ImportProductRow = { row: line, name };
    if (name.length > LIMITS.name) errors.push(`اسم المنتج أطول من ${LIMITS.name} حرف.`);

    // Barcodes never go through Number(): only whitespace is removed, so
    // leading zeros survive.
    let main = toStr(cell(r, "barcode")).replace(/\s+/g, "");
    if (main && !isValidBarcode(main)) {
      errors.push(`باركود غير صالح: ${main} (حروف لاتينية وأرقام و - _ فقط، 64 حرف كحد أقصى).`);
    }
    const extras: string[] = [];
    for (const col of extraBarcodeColumns) {
      if (col === mapping.barcode) continue;
      for (const piece of toStr(r[col]).split(/[,;|]/)) {
        const code = piece.replace(/\s+/g, "");
        if (!code) continue;
        if (!isValidBarcode(code)) {
          notes.push(`باركود إضافي غير صالح تم تجاهله: ${code}`);
          continue;
        }
        if (code !== main && !extras.includes(code)) extras.push(code);
      }
    }
    if (!main && extras.length > 0) main = extras.shift() as string;
    if (main && isValidBarcode(main)) payload.barcode = main;
    if (extras.length > LIMITS.extraBarcodes) errors.push(`أكثر من ${LIMITS.extraBarcodes} باركود إضافي في صف واحد.`);
    if (extras.length > 0) payload.extra_barcodes = extras;

    const internal = toStr(cell(r, "internal_code")).trim();
    if (internal) {
      if (internal.length > LIMITS.internalCode) errors.push(`الكود الداخلي أطول من ${LIMITS.internalCode} حرف.`);
      payload.internal_code = internal;
    }

    const num = (field: ImportField, label: string, check: (n: number) => string | null) => {
      const parsed = parseNumberCell(cell(r, field));
      if (parsed.kind === "empty") return;
      if (parsed.kind === "invalid") {
        errors.push(`${label} غير صالح: «${toStr(cell(r, field)).trim()}».`);
        return;
      }
      const problem = check(parsed.value);
      if (problem) {
        errors.push(problem);
        return;
      }
      (payload as Record<string, unknown>)[field] = parsed.value;
    };
    const priceCheck = (label: string) => (n: number) =>
      n < 0 || n > LIMITS.price ? `${label} لازم يكون بين 0 و 99,999,999.` : null;
    num("selling_price", "سعر البيع", priceCheck("سعر البيع"));
    num("purchase_price", "سعر الشراء", priceCheck("سعر الشراء"));
    num("stock_quantity", "المخزون", (n) => (Math.abs(n) > 9_999_999 ? "الكمية خارج الحدود المسموحة." : null));
    num("low_stock_threshold", "حد تنبيه المخزون", (n) => (n < 0 ? "حد تنبيه المخزون لازم يكون 0 أو أكثر." : null));
    num("points_reward", "نقاط الولاء", (n) =>
      !Number.isInteger(n) || n < 0 || n > LIMITS.points ? "نقاط الولاء لازم تكون عدد صحيح بين 0 و 10000." : null,
    );

    const unit = toStr(cell(r, "unit")).replace(/\s+/g, " ").trim();
    if (unit) {
      if (unit.length > LIMITS.unit) errors.push(`الوحدة أطول من ${LIMITS.unit} حرف.`);
      payload.unit = unit;
    }
    const category = toStr(cell(r, "category_name")).replace(/\s+/g, " ").trim();
    if (category) {
      if (category.length > LIMITS.category) errors.push(`اسم التصنيف أطول من ${LIMITS.category} حرف.`);
      payload.category_name = category;
    }
    const description = toStr(cell(r, "description")).trim();
    if (description) {
      if (description.length > LIMITS.description) errors.push(`الوصف أطول من ${LIMITS.description} حرف.`);
      payload.description = description;
    }
    const expiry = parseDateCell(cell(r, "expiry_date"));
    if (expiry.kind === "invalid") errors.push(`تاريخ الصلاحية غير صالح: «${toStr(cell(r, "expiry_date")).trim()}».`);
    else if (expiry.kind === "ok") payload.expiry_date = expiry.value;

    rows.push({ line, payload, errors, notes });
  });

  const merged = mergeSameNameRows(rows);
  flagInFileDuplicates(merged);
  return { rows: merged, skippedEmpty, skippedTotals };
}

/**
 * SUMA Web's "Universal Import" grouping (products.import.tsx
 * buildProductGroups): many POS exports list one product on several lines,
 * one line per barcode. Lines with the SAME name (case-insensitive) that do
 * not disagree on purchase price, selling price or stock are ONE product:
 * the first line leads, every other line's barcodes become its extra
 * barcodes, and fields the leader left blank are filled from the others.
 * Lines that do disagree are kept separate and flagged for review — merging
 * them would be a guess. Stock is compared the way SUMA Web does (blank
 * counts as 0) and is never summed.
 *
 * PC-only rule on top: two lines with different non-empty internal codes
 * are also kept separate (internal codes are unique per store, so a merge
 * would silently drop one). Lines with a client-side error never merge.
 */
export function mergeSameNameRows(rows: PreparedRow[]): PreparedRow[] {
  const out: PreparedRow[] = [];
  const leaders = new Map<string, PreparedRow>();
  const flagged = new Set<PreparedRow>();

  for (const row of rows) {
    if (row.errors.length > 0) {
      out.push(row);
      continue;
    }
    const key = row.payload.name.toLowerCase();
    const leader = leaders.get(key);
    if (!leader) {
      leaders.set(key, row);
      out.push(row);
      continue;
    }

    const a = leader.payload;
    const b = row.payload;
    const differs = (x: number | null | undefined, y: number | null | undefined) =>
      x !== undefined && x !== null && y !== undefined && y !== null && x !== y;
    const conflicting =
      differs(a.purchase_price, b.purchase_price) ||
      differs(a.selling_price, b.selling_price) ||
      (a.stock_quantity ?? 0) !== (b.stock_quantity ?? 0) ||
      (Boolean(a.internal_code) && Boolean(b.internal_code) && a.internal_code !== b.internal_code);

    if (conflicting) {
      const note = `نفس الاسم في السطرين ${leader.line} و${row.line} لكن بسعر/مخزون/كود مختلف — ما تدمجوش، راجعهم.`;
      if (!flagged.has(leader)) {
        leader.notes.push(note);
        flagged.add(leader);
      }
      row.notes.push(note);
      out.push(row);
      continue;
    }

    const codes = [b.barcode, ...(b.extra_barcodes ?? [])].filter((c): c is string => Boolean(c));
    const extras = [...(a.extra_barcodes ?? [])];
    for (const code of codes) {
      if (code === a.barcode || extras.includes(code)) continue;
      extras.push(code);
    }
    if (!a.barcode && extras.length > 0) a.barcode = extras.shift();
    if (extras.length > 0) a.extra_barcodes = extras;
    if (extras.length > LIMITS.extraBarcodes && !leader.errors.some((e) => e.includes("باركود إضافي في صف"))) {
      leader.errors.push(`أكثر من ${LIMITS.extraBarcodes} باركود إضافي في صف واحد.`);
    }
    const fill = <K extends keyof ImportProductRow>(k: K) => {
      if ((a[k] === undefined || a[k] === null) && b[k] !== undefined && b[k] !== null) a[k] = b[k];
    };
    fill("purchase_price");
    fill("selling_price");
    fill("stock_quantity");
    fill("internal_code");
    fill("unit");
    fill("category_name");
    fill("description");
    fill("expiry_date");
    fill("low_stock_threshold");
    fill("points_reward");

    leader.mergedLines = [...(leader.mergedLines ?? []), row.line];
    leader.notes.push(...row.notes);
  }

  for (const leader of leaders.values()) {
    if (leader.mergedLines && leader.mergedLines.length > 0) {
      leader.notes.unshift(`دُمجت معه الأسطر ${leader.mergedLines.join("، ")} (نفس الاسم) — باركوداتها أُضيفت كباركودات إضافية.`);
    }
  }
  return out;
}

/** A main barcode used by more than one row is an error on EVERY one of
 * them (which row should win is the owner's call, not ours). Rows with no
 * barcode/code sharing a name only get a note: the server matches those by
 * name, so the second one would update the first. */
function flagInFileDuplicates(rows: PreparedRow[]): void {
  const byBarcode = new Map<string, PreparedRow[]>();
  const byName = new Map<string, PreparedRow[]>();
  for (const row of rows) {
    const code = row.payload.barcode;
    if (code) byBarcode.set(code, [...(byBarcode.get(code) ?? []), row]);
    if (!code && !row.payload.internal_code) {
      const key = row.payload.name.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), row]);
    }
  }
  for (const [code, group] of byBarcode) {
    if (group.length < 2) continue;
    const lines = group.map((r) => r.line).join("، ");
    for (const row of group) row.errors.push(`باركود مكرر داخل الملف (${code}) في الأسطر: ${lines}.`);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const lines = group.map((r) => r.line).join("، ");
    for (const row of group) row.notes.push(`نفس الاسم بدون باركود ولا كود في الأسطر: ${lines} — سيُعتبر نفس المنتج.`);
  }
}

// ---- Preview (client flags + server dry run) ----------------------------

export type PreviewStatus = "new" | "update" | "skip" | "barcode_only" | "error";

export const PREVIEW_STATUS_LABEL: Record<PreviewStatus, string> = {
  new: "جديد",
  update: "تحديث",
  skip: "تجاهل",
  barcode_only: "باركودات فقط",
  error: "خطأ",
};

const STATUS_FROM_SERVER: Record<ImportRowStatus, PreviewStatus> = {
  created: "new",
  updated: "update",
  skipped: "skip",
  barcode_only: "barcode_only",
  error: "error",
};

export type PreviewRow = {
  line: number;
  name: string;
  barcode: string | null;
  sellingPrice: number | null;
  stock: number | null;
  status: PreviewStatus;
  reason: string | null;
  warnings: string[];
  /** Only rows with no client or dry-run error are imported. */
  importable: boolean;
  payload: ImportProductRow;
};

/** Merges the client-side preparation with the dry-run results (matched
 * by line number). Rows with client errors were never sent to the server. */
export function mergePreview(prepared: PreparedRow[], dryRun: Pick<ImportProductsResult, "results" | "warnings">): PreviewRow[] {
  const results = new Map(dryRun.results.map((r) => [r.row, r]));
  const warnings = new Map<number, string[]>();
  for (const w of dryRun.warnings) warnings.set(w.row, [...(warnings.get(w.row) ?? []), w.note]);

  return prepared.map((p) => {
    const base = {
      line: p.line,
      name: p.payload.name,
      barcode: p.payload.barcode ?? null,
      sellingPrice: p.payload.selling_price ?? null,
      stock: p.payload.stock_quantity ?? null,
      payload: p.payload,
    };
    if (p.errors.length > 0) {
      return { ...base, status: "error" as const, reason: p.errors.join(" "), warnings: p.notes, importable: false };
    }
    const server = results.get(p.line);
    const rowWarnings = [...p.notes, ...(warnings.get(p.line) ?? [])];
    if (!server) {
      return { ...base, status: "error" as const, reason: "لم يُرجع الخادم نتيجة لهذا الصف.", warnings: rowWarnings, importable: false };
    }
    const status = STATUS_FROM_SERVER[server.status];
    return {
      ...base,
      status,
      reason: server.reason ?? null,
      warnings: rowWarnings,
      importable: status !== "error",
    };
  });
}

export type ImportCounts = { created: number; updated: number; skipped: number; barcode_only: number; failed: number };

export function emptyCounts(): ImportCounts {
  return { created: 0, updated: 0, skipped: 0, barcode_only: 0, failed: 0 };
}

export function addCounts(a: ImportCounts, b: Partial<ImportCounts>): ImportCounts {
  return {
    created: a.created + (b.created ?? 0),
    updated: a.updated + (b.updated ?? 0),
    skipped: a.skipped + (b.skipped ?? 0),
    barcode_only: a.barcode_only + (b.barcode_only ?? 0),
    failed: a.failed + (b.failed ?? 0),
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be ≥ 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const IMPORT_CHUNK_SIZE = 500;

export const DUPLICATE_STRATEGY_LABEL: Record<ImportDuplicateStrategy, string> = {
  update: "تحديث المنتج الموجود",
  skip: "تجاهل",
  barcode_only: "إضافة الباركودات فقط",
  create_new: "إنشاء منتج جديد (بلا الباركود المكرر)",
};

// ---- CSV report, template, export ---------------------------------------

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 BOM + السطر,الاسم,السبب — opens correctly in Excel with Arabic. */
export function buildFailedRowsCsv(rows: Array<{ line: number; name: string; reason: string }>): string {
  const lines = ["السطر,الاسم,السبب", ...rows.map((r) => [r.line, r.name, r.reason].map(csvCell).join(","))];
  return "﻿" + lines.join("\r\n");
}

export const TEMPLATE_FILE_NAME = "نموذج-استيراد-سومة.xlsx";
export const TEMPLATE_SHEET_NAME = "منتجات";
export const TEMPLATE_HEADERS = [
  "name",
  "barcode",
  "extra_barcodes",
  "internal_code",
  "selling_price",
  "purchase_price",
  "stock_quantity",
  "unit",
  "category_name",
] as const;

/** SUMA Web's two sample rows, verbatim. */
export const TEMPLATE_ROWS: Array<Record<(typeof TEMPLATE_HEADERS)[number], string | number>> = [
  {
    name: "مثال: حليب 1 لتر",
    barcode: "6130001112223",
    extra_barcodes: "",
    internal_code: "",
    selling_price: 130,
    purchase_price: 110,
    stock_quantity: 40,
    unit: "قارورة",
    category_name: "ألبان",
  },
  {
    name: "مثال: مسحوق غسيل 750غ",
    barcode: "6130004445556",
    extra_barcodes: "6130004445557,6130004445558",
    internal_code: "",
    selling_price: 750,
    purchase_price: 650,
    stock_quantity: 60,
    unit: "علبة",
    category_name: "منظفات",
  },
];

/** SUMA Web's export columns (re-importable as-is) + unit. */
export const EXPORT_HEADERS = [
  "name",
  "internal_code",
  "category_name",
  "purchase_price",
  "selling_price",
  "stock_quantity",
  "barcode",
  "extra_barcodes",
  "unit",
] as const;

export type ExportRow = Record<(typeof EXPORT_HEADERS)[number], string | number>;

export function buildExportRow(
  p: {
    id: string;
    name: string;
    internal_code: string | null;
    category_id: string | null;
    purchase_price: number | null;
    selling_price: number | null;
    stock_quantity: number;
    barcode: string | null;
    unit: string | null;
  },
  categoryNames: Map<string, string>,
  extraBarcodes: Map<string, string[]>,
): ExportRow {
  return {
    name: p.name,
    internal_code: p.internal_code ?? "",
    category_name: p.category_id ? (categoryNames.get(p.category_id) ?? "") : "",
    purchase_price: p.purchase_price ?? "",
    selling_price: p.selling_price ?? "",
    stock_quantity: Number(p.stock_quantity),
    barcode: p.barcode ?? "",
    extra_barcodes: (extraBarcodes.get(p.id) ?? []).join(","),
    unit: p.unit ?? "",
  };
}
