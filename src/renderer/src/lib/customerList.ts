/**
 * Pure helpers behind the Customers page list (Phase B, SUMA Web parity):
 * search sanitising, the four list filters, the overdue ("دّين طويل")
 * rule, client-side pagination for the offline fallback, and create/edit
 * form validation. No React, no Supabase — unit-tested in isolation.
 */

import { isNetworkError } from "./net";

export type CustomerFilter = "all" | "debt" | "credit" | "overdue";

export const CUSTOMER_FILTERS: ReadonlyArray<{ key: CustomerFilter; label: string }> = [
  { key: "all", label: "الكل" },
  { key: "debt", label: "المديونين" },
  { key: "credit", label: "رصيد له" },
  { key: "overdue", label: "دّين طويل" },
];

/** SUMA Web falls back to 30 days when the store row has no value. */
export const DEFAULT_OVERDUE_DAYS = 30;

const DAY_MS = 86_400_000;

type CreditFields = { credit_balance: number | string; credit_since: string | null };
type SearchFields = { full_name: string; phone: string };

export function resolveOverdueDays(value: unknown): number {
  if (value === null || value === undefined || value === "") return DEFAULT_OVERDUE_DAYS;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_OVERDUE_DAYS;
}

/** Latest `credit_since` that still counts as overdue — the server-side
 * `.lte("credit_since", cutoff)` twin of `isCustomerOverdue`. */
export function overdueCutoffIso(overdueDays: number, now: Date = new Date()): string {
  return new Date(now.getTime() - overdueDays * DAY_MS).toISOString();
}

/** Same rule as SUMA Web: owes money AND has owed it for ≥ overdueDays. */
export function isCustomerOverdue(c: CreditFields, overdueDays: number, now: Date = new Date()): boolean {
  if (!(Number(c.credit_balance) > 0) || !c.credit_since) return false;
  const since = new Date(c.credit_since).getTime();
  if (Number.isNaN(since)) return false;
  return now.getTime() - since >= overdueDays * DAY_MS;
}

export type CreditState =
  | { kind: "debt"; amount: number }
  | { kind: "credit"; amount: number }
  | { kind: "none"; amount: 0 };

/** > 0: the customer owes the store. < 0: the store owes the customer
 * (overpaid) — `amount` is always the positive magnitude. */
export function customerCreditState(balance: number | string | null | undefined): CreditState {
  const n = Number(balance ?? 0);
  if (n > 0) return { kind: "debt", amount: n };
  if (n < 0) return { kind: "credit", amount: Math.abs(n) };
  return { kind: "none", amount: 0 };
}

/** Makes a free-text term safe to embed in a PostgREST `or(...)` filter:
 * drops the LIKE wildcard `%`, the filter separators `,` `(` `)`, `*`,
 * double quotes and backslashes, collapses whitespace, and caps the length. */
export function sanitizeCustomerSearch(raw: string): string {
  return raw
    .replace(/[%,()*\\"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function matchesCustomerSearch(c: SearchFields, term: string): boolean {
  const t = sanitizeCustomerSearch(term).toLowerCase();
  if (!t) return true;
  return c.full_name.toLowerCase().includes(t) || c.phone.toLowerCase().includes(t);
}

export function matchesCustomerFilter(
  c: CreditFields,
  filter: CustomerFilter,
  overdueDays: number,
  now: Date = new Date(),
): boolean {
  const balance = Number(c.credit_balance);
  switch (filter) {
    case "debt":
      return balance > 0;
    case "credit":
      return balance < 0;
    case "overdue":
      return isCustomerOverdue(c, overdueDays, now);
    default:
      return true;
  }
}

/** Offline fallback: the same filter/search the server query applies,
 * run over the local SQLite mirror, sorted by name like the server. */
export function filterCustomersLocal<T extends CreditFields & SearchFields>(
  rows: readonly T[],
  opts: { term: string; filter: CustomerFilter; overdueDays: number; now?: Date },
): T[] {
  const now = opts.now ?? new Date();
  return rows
    .filter((c) => matchesCustomerFilter(c, opts.filter, opts.overdueDays, now))
    .filter((c) => matchesCustomerSearch(c, opts.term))
    .sort((a, b) => a.full_name.localeCompare(b.full_name, "ar"));
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(0, page), pageCount(total, pageSize) - 1);
}

/** Inclusive [from, to] indices for Supabase's `.range()`. */
export function pageRange(page: number, pageSize: number): { from: number; to: number } {
  const from = Math.max(0, page) * pageSize;
  return { from, to: from + pageSize - 1 };
}

export function paginateLocal<T>(rows: readonly T[], page: number, pageSize: number): { rows: T[]; page: number } {
  const p = clampPage(page, rows.length, pageSize);
  return { rows: rows.slice(p * pageSize, (p + 1) * pageSize), page: p };
}

/** "عرض 26–50 من 120" — empty string when there is nothing to show. */
export function pageSummary(page: number, pageSize: number, total: number): string {
  if (total <= 0) return "";
  const first = page * pageSize + 1;
  const last = Math.min(total, (page + 1) * pageSize);
  return `عرض ${first}–${last} من ${total}`;
}

export type CustomerInputResult =
  | { ok: true; fullName: string; phone: string }
  | { ok: false; error: string };

/** Mirrors create_customer()/update_customer()'s own checks (name 2–120,
 * phone 8–30, both trimmed) so obvious mistakes never leave the machine;
 * the RPC stays the authority (duplicates etc.). */
export function validateCustomerInput(fullName: string, phone: string): CustomerInputResult {
  const name = fullName.trim().replace(/\s+/g, " ");
  const tel = phone.trim();
  if (name.length < 2) return { ok: false, error: "الاسم لازم يكون حرفين على الأقل." };
  if (name.length > 120) return { ok: false, error: "الاسم طويل بزاف (120 حرف كحد أقصى)." };
  if (tel.length < 8) return { ok: false, error: "رقم الهاتف لازم يكون 8 أرقام على الأقل." };
  if (tel.length > 30) return { ok: false, error: "رقم الهاتف طويل بزاف (30 رمز كحد أقصى)." };
  return { ok: true, fullName: name, phone: tel };
}

export function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "؟";
}

/** Server (RPC) messages are already Arabic and shown as-is; only raw
 * transport failures get a readable Arabic replacement. */
export function friendlyCustomerError(message: string | null | undefined): string {
  if (!message) return "حدث خطأ غير متوقع.";
  if (isNetworkError(message)) return "تعذر الاتصال بالخادم — تحقق من الإنترنت وأعد المحاولة.";
  return message;
}
