import { describe, expect, it } from "vitest";
import { availablePointsModes, formatPointsDelta, POINTS_REASON_LABEL, validatePointsAdjustment } from "./customerPoints";

describe("availablePointsModes", () => {
  it("gives manual adjust to store admins only", () => {
    expect(availablePointsModes({ isAdmin: true, canManageCustomers: true })).toEqual(["manual_adjust", "redeem"]);
    expect(availablePointsModes({ isAdmin: false, canManageCustomers: true })).toEqual(["redeem"]);
    expect(availablePointsModes({ isAdmin: false, canManageCustomers: false })).toEqual([]);
  });
});

describe("validatePointsAdjustment", () => {
  const base = { mode: "manual_adjust" as const, direction: "add" as const, amountText: "50", balance: 100, note: "هدية" };

  it("adds for manual adjust + add", () => {
    expect(validatePointsAdjustment(base)).toEqual({ ok: true, delta: 50, notes: "هدية" });
  });

  it("deducts for manual adjust + deduct, bounded by the balance", () => {
    expect(validatePointsAdjustment({ ...base, direction: "deduct" })).toEqual({ ok: true, delta: -50, notes: "هدية" });
    expect(validatePointsAdjustment({ ...base, direction: "deduct", amountText: "101" }).ok).toBe(false);
  });

  it("requires a note for manual adjust but not for redeem", () => {
    expect(validatePointsAdjustment({ ...base, note: "   " }).ok).toBe(false);
    expect(validatePointsAdjustment({ ...base, mode: "redeem", note: "" })).toEqual({ ok: true, delta: -50, notes: undefined });
  });

  it("redeem always deducts, even if direction says add", () => {
    const r = validatePointsAdjustment({ ...base, mode: "redeem", direction: "add" });
    expect(r).toEqual({ ok: true, delta: -50, notes: "هدية" });
    expect(validatePointsAdjustment({ ...base, mode: "redeem", amountText: "150" }).ok).toBe(false);
  });

  it("rejects zero, negative, non-numeric and huge amounts", () => {
    for (const amountText of ["", "0", "-5", "abc", "2000000"]) {
      expect(validatePointsAdjustment({ ...base, amountText }).ok).toBe(false);
    }
    expect(validatePointsAdjustment({ ...base, amountText: "2,5" })).toEqual({ ok: true, delta: 2.5, notes: "هدية" });
  });
});

describe("labels", () => {
  it("covers every ledger reason", () => {
    expect(POINTS_REASON_LABEL.opening).toBe("رصيد افتتاحي");
    expect(POINTS_REASON_LABEL.redeem).toBe("استبدال");
    expect(Object.keys(POINTS_REASON_LABEL)).toHaveLength(7);
  });

  it("formats deltas with a sign", () => {
    expect(formatPointsDelta(5)).toBe("+5");
    expect(formatPointsDelta(-5)).toBe("−5");
    expect(formatPointsDelta(0)).toBe("0");
  });
});
