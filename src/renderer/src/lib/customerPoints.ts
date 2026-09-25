import type { PointsLedgerReason } from "./database.types";

/** Pure helpers for loyalty points: ledger labels and the adjust/redeem
 * dialog's validation (adjust_customer_points() stays the authority). */

export const POINTS_REASON_LABEL: Record<PointsLedgerReason, string> = {
  opening: "رصيد افتتاحي",
  sale: "مبيعات",
  refund: "استرجاع",
  sale_edit: "تعديل عملية بيع",
  manual_adjust: "تعديل يدوي",
  redeem: "استبدال",
  system: "نظام",
};

export type PointsMode = "manual_adjust" | "redeem";

export const POINTS_MODE_LABEL: Record<PointsMode, string> = {
  manual_adjust: "تعديل يدوي",
  redeem: "استبدال نقاط",
};

/** 'manual_adjust' is store-admin only (owner/manager); 'redeem' is open to
 * admins and anyone with can_manage_customers — same split as the RPC. */
export function availablePointsModes(perms: { isAdmin: boolean; canManageCustomers: boolean }): PointsMode[] {
  const modes: PointsMode[] = [];
  if (perms.isAdmin) modes.push("manual_adjust");
  if (perms.isAdmin || perms.canManageCustomers) modes.push("redeem");
  return modes;
}

export const POINTS_MAX_DELTA = 1_000_000;

export type PointsValidation = { ok: true; delta: number; notes: string | undefined } | { ok: false; error: string };

export function validatePointsAdjustment(input: {
  mode: PointsMode;
  /** Only meaningful for manual_adjust; redeem always deducts. */
  direction: "add" | "deduct";
  amountText: string;
  balance: number | string;
  note: string;
}): PointsValidation {
  const raw = input.amountText.trim().replace(",", ".");
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "عدد النقاط لازم يكون أكبر من صفر." };
  }
  if (amount > POINTS_MAX_DELTA) return { ok: false, error: "عدد النقاط كبير بزاف." };
  const note = input.note.trim().slice(0, 300);
  const balance = Number(input.balance) || 0;
  const deduct = input.mode === "redeem" || input.direction === "deduct";
  if (input.mode === "manual_adjust" && !note) {
    return { ok: false, error: "اكتب سبب التعديل اليدوي." };
  }
  if (deduct && amount > balance) {
    return { ok: false, error: `رصيد النقاط غير كافٍ (المتاح: ${balance}).` };
  }
  return { ok: true, delta: deduct ? -amount : amount, notes: note || undefined };
}

export function formatPointsDelta(delta: number | string): string {
  const n = Number(delta);
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}
