import { describe, expect, it } from "vitest";
import {
  clampPage,
  customerCreditState,
  customerInitials,
  filterCustomersLocal,
  isCustomerOverdue,
  matchesCustomerSearch,
  overdueCutoffIso,
  pageCount,
  pageRange,
  pageSummary,
  paginateLocal,
  resolveOverdueDays,
  sanitizeCustomerSearch,
  validateCustomerInput,
} from "./customerList";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("overdue rule", () => {
  it("is overdue only with a positive balance held for >= overdueDays", () => {
    expect(isCustomerOverdue({ credit_balance: 500, credit_since: daysAgo(30) }, 30, NOW)).toBe(true);
    expect(isCustomerOverdue({ credit_balance: 500, credit_since: daysAgo(31) }, 30, NOW)).toBe(true);
    expect(isCustomerOverdue({ credit_balance: 500, credit_since: daysAgo(29.9) }, 30, NOW)).toBe(false);
  });

  it("is never overdue without debt or without credit_since", () => {
    expect(isCustomerOverdue({ credit_balance: 0, credit_since: daysAgo(90) }, 30, NOW)).toBe(false);
    expect(isCustomerOverdue({ credit_balance: -200, credit_since: daysAgo(90) }, 30, NOW)).toBe(false);
    expect(isCustomerOverdue({ credit_balance: 200, credit_since: null }, 30, NOW)).toBe(false);
    expect(isCustomerOverdue({ credit_balance: "200", credit_since: "not a date" }, 30, NOW)).toBe(false);
  });

  it("accepts numeric strings for the balance", () => {
    expect(isCustomerOverdue({ credit_balance: "10.50", credit_since: daysAgo(40) }, 30, NOW)).toBe(true);
  });

  it("server cutoff agrees with the client rule at the boundary", () => {
    const cutoff = overdueCutoffIso(30, NOW);
    expect(cutoff).toBe(daysAgo(30));
    // credit_since <= cutoff  <=>  isCustomerOverdue
    expect(isCustomerOverdue({ credit_balance: 1, credit_since: cutoff }, 30, NOW)).toBe(true);
    const justAfter = new Date(new Date(cutoff).getTime() + 1).toISOString();
    expect(isCustomerOverdue({ credit_balance: 1, credit_since: justAfter }, 30, NOW)).toBe(false);
  });

  it("falls back to 30 days like SUMA Web", () => {
    expect(resolveOverdueDays(null)).toBe(30);
    expect(resolveOverdueDays(undefined)).toBe(30);
    expect(resolveOverdueDays("abc")).toBe(30);
    expect(resolveOverdueDays(-5)).toBe(30);
    expect(resolveOverdueDays(45)).toBe(45);
    expect(resolveOverdueDays("15")).toBe(15);
    expect(resolveOverdueDays(0)).toBe(0);
  });
});

describe("customerCreditState", () => {
  it("maps the three balance semantics", () => {
    expect(customerCreditState(1500)).toEqual({ kind: "debt", amount: 1500 });
    expect(customerCreditState(-250)).toEqual({ kind: "credit", amount: 250 });
    expect(customerCreditState(0)).toEqual({ kind: "none", amount: 0 });
    expect(customerCreditState(null)).toEqual({ kind: "none", amount: 0 });
    expect(customerCreditState("-0.5")).toEqual({ kind: "credit", amount: 0.5 });
  });
});

describe("search", () => {
  it("strips PostgREST-breaking characters and wildcards", () => {
    expect(sanitizeCustomerSearch("  ahmed%,(x)*  ")).toBe("ahmed x");
    expect(sanitizeCustomerSearch("a\\b")).toBe("a b");
    expect(sanitizeCustomerSearch("%%%")).toBe("");
    expect(sanitizeCustomerSearch("x".repeat(100))).toHaveLength(60);
  });

  it("matches name case-insensitively or phone substring", () => {
    const c = { full_name: "Karim Benali", phone: "0555123456" };
    expect(matchesCustomerSearch(c, "")).toBe(true);
    expect(matchesCustomerSearch(c, "karim")).toBe(true);
    expect(matchesCustomerSearch(c, "BENALI")).toBe(true);
    expect(matchesCustomerSearch(c, "5512")).toBe(true);
    expect(matchesCustomerSearch(c, "yacine")).toBe(false);
  });
});

describe("filterCustomersLocal", () => {
  const rows = [
    { id: "1", full_name: "سمير", phone: "0551000001", credit_balance: 1000, credit_since: daysAgo(60) },
    { id: "2", full_name: "أحمد", phone: "0551000002", credit_balance: 300, credit_since: daysAgo(3) },
    { id: "3", full_name: "بلال", phone: "0551000003", credit_balance: -50, credit_since: null },
    { id: "4", full_name: "جمال", phone: "0661000004", credit_balance: 0, credit_since: null },
  ];

  it("applies each filter", () => {
    const ids = (filter: "all" | "debt" | "credit" | "overdue", term = "") =>
      filterCustomersLocal(rows, { filter, term, overdueDays: 30, now: NOW }).map((r) => r.id);
    expect(ids("all").sort()).toEqual(["1", "2", "3", "4"]);
    expect(ids("debt").sort()).toEqual(["1", "2"]);
    expect(ids("credit")).toEqual(["3"]);
    expect(ids("overdue")).toEqual(["1"]);
    expect(ids("all", "0661")).toEqual(["4"]);
    expect(ids("debt", "0661")).toEqual([]);
  });

  it("sorts by name", () => {
    const names = filterCustomersLocal(rows, { filter: "all", term: "", overdueDays: 30, now: NOW }).map((r) => r.full_name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ar")));
  });
});

describe("pagination", () => {
  it("computes page counts and clamps", () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(clampPage(5, 26, 25)).toBe(1);
    expect(clampPage(-1, 26, 25)).toBe(0);
    expect(clampPage(3, 0, 25)).toBe(0);
  });

  it("builds inclusive .range() bounds", () => {
    expect(pageRange(0, 25)).toEqual({ from: 0, to: 24 });
    expect(pageRange(2, 25)).toEqual({ from: 50, to: 74 });
  });

  it("paginates locally with clamping", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(paginateLocal(items, 0, 25).rows).toHaveLength(25);
    expect(paginateLocal(items, 1, 25)).toEqual({ rows: [25, 26, 27, 28, 29], page: 1 });
    expect(paginateLocal(items, 9, 25).page).toBe(1);
    expect(paginateLocal([], 3, 25)).toEqual({ rows: [], page: 0 });
  });

  it("summarises the visible window", () => {
    expect(pageSummary(0, 25, 0)).toBe("");
    expect(pageSummary(0, 25, 10)).toBe("عرض 1–10 من 10");
    expect(pageSummary(1, 25, 60)).toBe("عرض 26–50 من 60");
    expect(pageSummary(2, 25, 60)).toBe("عرض 51–60 من 60");
  });
});

describe("validateCustomerInput", () => {
  it("trims and accepts valid input", () => {
    expect(validateCustomerInput("  Karim   Benali ", " 0555123456 ")).toEqual({
      ok: true,
      fullName: "Karim Benali",
      phone: "0555123456",
    });
  });

  it("enforces the RPC's length bounds", () => {
    expect(validateCustomerInput("K", "0555123456").ok).toBe(false);
    expect(validateCustomerInput("x".repeat(121), "0555123456").ok).toBe(false);
    expect(validateCustomerInput("Karim", "0555123").ok).toBe(false);
    expect(validateCustomerInput("Karim", "1".repeat(31)).ok).toBe(false);
    expect(validateCustomerInput("Ka", "05551234").ok).toBe(true);
  });
});

describe("customerInitials", () => {
  it("takes up to two initials", () => {
    expect(customerInitials("karim benali")).toBe("KB");
    expect(customerInitials("سمير")).toBe("س");
    expect(customerInitials("   ")).toBe("؟");
  });
});
