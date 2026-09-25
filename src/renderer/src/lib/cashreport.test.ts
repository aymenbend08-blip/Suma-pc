import { describe, expect, it } from "vitest";
import { computeExpectedCash, computeVariance, summarizeSalesByMethod } from "./cashreport";

describe("summarizeSalesByMethod", () => {
  it("nets each method's total against its own refunded_amount", () => {
    const totals = summarizeSalesByMethod([
      { total_amount: 1000, refunded_amount: 200, payment_method: "cash" },
      { total_amount: 500, refunded_amount: 0, payment_method: "card" },
      { total_amount: 300, refunded_amount: 300, payment_method: "credit" },
    ]);
    expect(totals).toEqual({ cash: 800, card: 500, credit: 0 });
  });

  it("returns all zeros for no sales", () => {
    expect(summarizeSalesByMethod([])).toEqual({ cash: 0, card: 0, credit: 0 });
  });
});

describe("computeExpectedCash", () => {
  it("mirrors close_register()'s exact formula: opening + sales - refunds + payments - expenses", () => {
    const expected = computeExpectedCash({
      openingBalance: 5000,
      cashSalesGross: 12000,
      cashRefunds: 1500,
      cashPayments: 2000,
      cashExpenses: 800,
    });
    // 5000 + 12000 - 1500 + 2000 - 800 = 16700
    expect(expected).toBe(16700);
  });

  it("handles an empty session (just the opening float)", () => {
    expect(
      computeExpectedCash({ openingBalance: 3000, cashSalesGross: 0, cashRefunds: 0, cashPayments: 0, cashExpenses: 0 }),
    ).toBe(3000);
  });
});

describe("computeVariance", () => {
  it("flags a shortage when counted cash is below expected", () => {
    const v = computeVariance(10000, 9500);
    expect(v.variance).toBe(-500);
    expect(v.isShort).toBe(true);
    expect(v.isOver).toBe(false);
  });

  it("flags an overage when counted cash is above expected", () => {
    const v = computeVariance(10000, 10200);
    expect(v.variance).toBe(200);
    expect(v.isShort).toBe(false);
    expect(v.isOver).toBe(true);
  });

  it("is exact (zero variance) when counted matches expected", () => {
    const v = computeVariance(7500, 7500);
    expect(v.variance).toBe(0);
    expect(v.isShort).toBe(false);
    expect(v.isOver).toBe(false);
  });
});
