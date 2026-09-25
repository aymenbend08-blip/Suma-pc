/**
 * Pure cash-register reconciliation math — extracted so it's testable
 * without a browser (same reasoning as lib/profit.ts and lib/net.ts).
 *
 * Mirrors close_register()'s own formula EXACTLY (opening_balance +
 * cash_sales - cash_refunds + cash_payments - cash_expenses) so the two
 * numbers are directly comparable — the only difference CashRegisterPage
 * introduces is which timestamp column feeds `cash_sales`/`cash_refunds`.
 * The server RPC buckets by `sales.created_at` (sync time); this function
 * is fed rows the caller has already filtered by `occurred_at` (the real
 * sale moment), which is what closes the known offline-sync skew bug on
 * Desktop's OWN report even though the RPC's own stored `expected_cash`
 * still carries it for any offline-synced sale in the window.
 */

export type CashReportSaleRow = {
  total_amount: number;
  refunded_amount: number;
  payment_method: "cash" | "card" | "credit";
};

export type MethodTotals = { cash: number; card: number; credit: number };

/** Net-of-refund totals per payment method — for the "sales in this
 * session" breakdown shown in the report (display only, not the
 * expected-cash formula itself). */
export function summarizeSalesByMethod(sales: CashReportSaleRow[]): MethodTotals {
  const totals: MethodTotals = { cash: 0, card: 0, credit: 0 };
  for (const s of sales) {
    const net = Number(s.total_amount) - Number(s.refunded_amount);
    totals[s.payment_method] += net;
  }
  return totals;
}

export type ExpectedCashInputs = {
  openingBalance: number;
  /** Sum of total_amount for cash sales in the window (gross — refunds
   * are subtracted separately below, matching close_register()'s own
   * two-step formula rather than netting them in one pass). */
  cashSalesGross: number;
  /** Sum of refunded_amount for cash sales refunded in the window. */
  cashRefunds: number;
  /** Sum of customer_payments.amount recorded in the window (cash coming
   * in from credit collections). */
  cashPayments: number;
  /** Sum of expenses.amount recorded in the window (cash going out). */
  cashExpenses: number;
};

export function computeExpectedCash(inputs: ExpectedCashInputs): number {
  return (
    Number(inputs.openingBalance) +
    Number(inputs.cashSalesGross) -
    Number(inputs.cashRefunds) +
    Number(inputs.cashPayments) -
    Number(inputs.cashExpenses)
  );
}

export type Variance = { expected: number; actual: number; variance: number; isShort: boolean; isOver: boolean };

/** actual - expected, same sign convention close_register() stores in
 * `variance` (positive = more cash counted than expected, negative =
 * short). */
export function computeVariance(expected: number, actual: number): Variance {
  const variance = Number(actual) - Number(expected);
  return { expected: Number(expected), actual: Number(actual), variance, isShort: variance < 0, isOver: variance > 0 };
}
