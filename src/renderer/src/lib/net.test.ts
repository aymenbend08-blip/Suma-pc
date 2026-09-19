import { describe, expect, it } from "vitest";
import { isNetworkError } from "./net";

describe("isNetworkError", () => {
  it("matches the actual browser fetch-failure message", () => {
    // What Chromium's fetch() rejection looks like once postgrest-js
    // formats it as `${error.name}: ${error.message}` (verified against
    // the installed @supabase/postgrest-js source, see PostgrestBuilder.ts).
    expect(isNetworkError("TypeError: Failed to fetch")).toBe(true);
  });

  it("matches other network-shaped messages", () => {
    expect(isNetworkError("network request failed")).toBe(true);
    expect(isNetworkError("connection timeout")).toBe(true);
    expect(isNetworkError("net::ERR_CONNECTION_RESET")).toBe(true);
  });

  it("does not match record_sale()'s actual business-rejection messages", () => {
    // The real strings record_sale()/pay_customer_credit() raise
    // (supabase/migrations/20260919130000_record_sale_stock_check.sql and
    // 20260919000000_pay_customer_credit_idempotency.sql) — must never be
    // misclassified as a network failure, or a genuine rejection would
    // silently become an offline sale instead of being shown to the cashier.
    expect(isNetworkError("الكمية المطلوبة (5) أكبر من المخزون المتوفر (2.000) لـ حليب.")).toBe(false);
    expect(isNetworkError("المبلغ أكبر من الدّين المتبقي على هذا الزبون.")).toBe(false);
    expect(isNetworkError("ما عندكش صلاحية البيع في هذا المحل.")).toBe(false);
    expect(isNetworkError("الزبون غير موجود أو غير مؤكَّد.")).toBe(false);
  });
});
