import { describe, expect, it } from "vitest";
import { computeProfit } from "./profit";

describe("computeProfit", () => {
  it("does not show a manual/no-barcode item's full revenue as margin", () => {
    // The exact confirmed bug scenario: a 500 DA cash sale made entirely
    // of one manual line (product_id: null) must NOT be treated as 500 DA
    // of pure profit just because its cost is unknown.
    const result = computeProfit(
      [{ total_amount: 500, refunded_amount: 0 }],
      [{ product_id: null, quantity: 1, refunded_quantity: 0, unit_price: 500 }],
      [],
    );
    expect(result.revenue).toBe(500);
    expect(result.cost).toBe(0); // nothing was invented as a cost either
    expect(result.margin).toBe(0); // NOT 500 — unknown-cost revenue excluded from margin
    expect(result.unknownCostRevenue).toBe(500); // disclosed instead of hidden
  });

  it("treats a real product with no recorded purchase_price the same way — never assumed free", () => {
    const result = computeProfit(
      [{ total_amount: 300, refunded_amount: 0 }],
      [{ product_id: "p1", quantity: 2, refunded_quantity: 0, unit_price: 150 }],
      [{ id: "p1", purchase_price: null }],
    );
    expect(result.cost).toBe(0);
    expect(result.margin).toBe(0);
    expect(result.unknownCostRevenue).toBe(300);
  });

  it("computes normal products with a known cost exactly as before (regression)", () => {
    const result = computeProfit(
      [{ total_amount: 200, refunded_amount: 0 }],
      [{ product_id: "p1", quantity: 2, refunded_quantity: 0, unit_price: 100 }],
      [{ id: "p1", purchase_price: 60 }],
    );
    expect(result.revenue).toBe(200);
    expect(result.cost).toBe(120); // 2 * 60
    expect(result.margin).toBe(80);
    expect(result.unknownCostRevenue).toBe(0);
  });

  it("keeps partial-refund math exactly as before (regression)", () => {
    // 10 units sold at 100 (purchase_price 60), 4 refunded.
    const result = computeProfit(
      [{ total_amount: 1000, refunded_amount: 400 }],
      [{ product_id: "p1", quantity: 10, refunded_quantity: 4, unit_price: 100 }],
      [{ id: "p1", purchase_price: 60 }],
    );
    expect(result.revenue).toBe(600); // 1000 - 400
    expect(result.cost).toBe(360); // (10-4) * 60
    expect(result.margin).toBe(240);
    expect(result.unknownCostRevenue).toBe(0);
  });

  it("mixes a known-cost product and a manual item in the same sale correctly", () => {
    const result = computeProfit(
      [{ total_amount: 600, refunded_amount: 0 }],
      [
        { product_id: "p1", quantity: 1, refunded_quantity: 0, unit_price: 100 }, // known cost 60
        { product_id: null, quantity: 1, refunded_quantity: 0, unit_price: 500 }, // manual, unknown cost
      ],
      [{ id: "p1", purchase_price: 60 }],
    );
    expect(result.revenue).toBe(600); // full revenue, unchanged
    expect(result.cost).toBe(60); // known cost only
    // Margin only over the known-cost portion (100 revenue - 60 cost = 40)
    // — the manual line's 500 DA is excluded, never assumed to be pure profit.
    expect(result.margin).toBe(40);
    expect(result.unknownCostRevenue).toBe(500);
  });

  it("never lets a fully-refunded manual line contribute negative disclosed revenue", () => {
    const result = computeProfit(
      [{ total_amount: 500, refunded_amount: 500 }],
      [{ product_id: null, quantity: 1, refunded_quantity: 1, unit_price: 500 }],
      [],
    );
    expect(result.unknownCostRevenue).toBe(0); // effectiveQty floored at 0
    expect(result.margin).toBe(0);
  });

  it("returns all zeros for no sales", () => {
    expect(computeProfit([], [], [])).toEqual({ revenue: 0, cost: 0, margin: 0, unknownCostRevenue: 0 });
  });
});
