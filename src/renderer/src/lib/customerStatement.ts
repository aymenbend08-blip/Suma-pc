import type { StatementKind, StatementLine } from "./database.types";

/**
 * Pure helpers for the customer statement (كشف الحساب): labels, the
 * local-day → ISO range conversion sent to get_customer_statement(),
 * batching for print/export, and CSV building. Balances themselves are
 * always computed server-side — nothing here recomputes a running balance.
 */

export const STATEMENT_KIND_LABEL: Record<StatementKind, string> = {
  credit_sale: "بيع بالكريدي",
  cash_sale: "بيع نقدًا",
  card_sale: "بيع بالبطاقة",
  refund: "استرجاع",
  payment: "تسديد",
};

export const STATEMENT_KIND_FILTERS: ReadonlyArray<{ kind: StatementKind; label: string }> = [
  { kind: "credit_sale", label: "مبيعات كريدي" },
  { kind: "cash_sale", label: "نقدًا" },
  { kind: "card_sale", label: "بطاقة" },
  { kind: "refund", label: "استرجاع" },
  { kind: "payment", label: "تسديد" },
];

/** Page size for the on-screen statement, and the RPC's own hard cap. */
export const STATEMENT_PAGE_SIZE = 50;
export const STATEMENT_BATCH_SIZE = 500;
/** Upper bound on rows pulled for a single print/export. */
export const STATEMENT_EXPORT_CAP = 5000;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number, width = 2): string {
  return String(Math.trunc(Math.abs(n))).padStart(width, "0");
}

/** ISO-8601 with the machine's own UTC offset at that instant (DST-safe),
 * e.g. `2026-09-25T00:00:00.000+01:00`. */
export function toLocalIsoWithOffset(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}

function parseYmd(ymd: string): [number, number, number] | null {
  const m = YMD.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return [y, mo, d];
}

/** `<input type="date">` value → start of that LOCAL day (00:00:00.000).
 * Deliberately not `new Date("YYYY-MM-DD")`, which parses as UTC midnight. */
export function localDayStartIso(ymd: string): string | null {
  const p = parseYmd(ymd);
  if (!p) return null;
  return toLocalIsoWithOffset(new Date(p[0], p[1] - 1, p[2], 0, 0, 0, 0));
}

/** End of that LOCAL day (23:59:59.999) — the RPC's `_to` is inclusive. */
export function localDayEndIso(ymd: string): string | null {
  const p = parseYmd(ymd);
  if (!p) return null;
  return toLocalIsoWithOffset(new Date(p[0], p[1] - 1, p[2], 23, 59, 59, 999));
}

/** An empty bound on either side is always valid. */
export function isValidDateRange(fromYmd: string, toYmd: string): boolean {
  if (!fromYmd || !toYmd) return true;
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmd);
  if (!a || !b) return true;
  return fromYmd <= toYmd;
}

export function shortRef(id: string | null | undefined): string {
  if (!id) return "—";
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** True when customers.credit_balance disagrees with the balance rebuilt
 * from the full history — shown as a visible warning, never hidden. */
export function hasBalanceDrift(computed: number | string, recorded: number | string, tolerance = 0.01): boolean {
  return Math.abs(Number(computed) - Number(recorded)) > tolerance;
}

/** Sale and refund lines reference a sale id whose items can be shown. */
export function isSaleLinkedKind(kind: StatementKind): boolean {
  return kind !== "payment";
}

/** Offsets to request for a full print/export of `total` filtered rows. */
export function statementBatchOffsets(
  total: number,
  batchSize: number = STATEMENT_BATCH_SIZE,
  cap: number = STATEMENT_EXPORT_CAP,
): number[] {
  const limit = Math.min(Math.max(0, total), cap);
  const offsets: number[] = [];
  for (let o = 0; o < limit; o += batchSize) offsets.push(o);
  return offsets;
}

/** The RPC returns newest-first; printed/exported statements read oldest-first. */
export function toChronological<T>(rowsNewestFirst: readonly T[]): T[] {
  return [...rowsNewestFirst].reverse();
}

/** Local "YYYY-MM-DD HH:mm" — sortable and spreadsheet-friendly. */
export function formatCsvDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function money(n: number | string): string {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "";
}

export const STATEMENT_CSV_HEADERS = ["التاريخ", "النوع", "المرجع", "المبلغ", "مدين", "دائن", "الرصيد بعد العملية"];

/** UTF-8 BOM + CRLF so Excel opens Arabic text correctly. Rows are given
 * newest-first (as the RPC returns them) and written oldest-first,
 * framed by the opening and closing balances of the period. */
export function buildStatementCsv(input: {
  rows: readonly StatementLine[];
  openingBalance: number | string;
  closingBalance: number | string;
}): string {
  const lines: string[] = [STATEMENT_CSV_HEADERS.map(csvEscape).join(",")];
  lines.push(["", "رصيد افتتاحي", "", "", "", "", money(input.openingBalance)].map(csvEscape).join(","));
  for (const r of toChronological(input.rows)) {
    lines.push(
      [
        formatCsvDateTime(r.occurred_at),
        STATEMENT_KIND_LABEL[r.kind] ?? r.kind,
        shortRef(r.reference_id),
        money(r.amount),
        money(r.debit),
        money(r.credit),
        money(r.balance_after),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  lines.push(["", "رصيد ختامي", "", "", "", "", money(input.closingBalance)].map(csvEscape).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
