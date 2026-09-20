/**
 * Pure profit/loss math for DashboardPage, extracted so it's testable
 * without a browser (mirrors lib/net.ts's decision functions).
 *
 * A sale_items line only contributes to COGS when it has a KNOWN,
 * reliable cost — a real product with a recorded purchase_price. Two
 * cases never get a cost:
 *   - a manual/no-barcode line (product_id is null — sale_items carries
 *     no cost of its own for these), and
 *   - a real product whose purchase_price was never recorded (null).
 * Neither is ever assumed to be free (cost = 0) — that would silently
 * inflate margin by exactly its full revenue. Instead their revenue is
 * tracked separately as `unknownCostRevenue`, excluded from COGS and
 * from the margin, so the UI can disclose it instead of hiding it inside
 * an inflated profit figure.
 */

export type SaleRowForProfit = { total_amount: number; refunded_amount: number };
export type SaleItemForProfit = { product_id: string | null; quantity: number; refunded_quantity: number; unit_price: number };
export type ProductCostRow = { id: string; purchase_price: number | null };

export type ProfitCalc = {
  revenue: number;
  cost: number;
  margin: number;
  /** Revenue from lines with no known/reliable cost basis — not counted
   * in `cost` or `margin`, and must be disclosed rather than dropped. */
  unknownCostRevenue: number;
};

export function computeProfit(
  sales: SaleRowForProfit[],
  items: SaleItemForProfit[],
  products: ProductCostRow[],
): ProfitCalc {
  let revenue = 0;
  for (const s of sales) revenue += Number(s.total_amount) - Number(s.refunded_amount);

  const knownCostById = new Map<string, number>();
  for (const p of products) {
    if (p.purchase_price !== null) knownCostById.set(p.id, Number(p.purchase_price));
  }

  let cost = 0;
  let unknownCostRevenue = 0;
  for (const item of items) {
    const effectiveQty = Math.max(0, Number(item.quantity) - Number(item.refunded_quantity));
    const knownCost = item.product_id ? knownCostById.get(item.product_id) : undefined;
    if (knownCost !== undefined) {
      cost += knownCost * effectiveQty;
    } else {
      unknownCostRevenue += Number(item.unit_price) * effectiveQty;
    }
  }

  // Margin is computed only over revenue that HAS a known cost basis —
  // revenue with no reliable cost is excluded from margin entirely
  // (disclosed separately via unknownCostRevenue) rather than folded in
  // at an implied cost of zero, which is what silently inflated it before.
  const knownRevenue = revenue - unknownCostRevenue;
  return { revenue, cost, margin: knownRevenue - cost, unknownCostRevenue };
}
