import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StatementLine } from "./database.types";
import {
  buildStatementCsv,
  csvEscape,
  formatCsvDateTime,
  hasBalanceDrift,
  isSaleLinkedKind,
  isValidDateRange,
  localDayEndIso,
  localDayStartIso,
  shortRef,
  statementBatchOffsets,
  STATEMENT_KIND_LABEL,
  toChronological,
  toLocalIsoWithOffset,
} from "./customerStatement";

const ORIGINAL_TZ = process.env.TZ;

function withTz<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = "Africa/Algiers";
  }
}

beforeAll(() => {
  process.env.TZ = "Africa/Algiers"; // UTC+1, no DST — the stores' own zone
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("local day bounds", () => {
  it("sends local midnight / end of day with the local offset (Algiers, UTC+1)", () => {
    expect(localDayStartIso("2026-09-25")).toBe("2026-09-25T00:00:00.000+01:00");
    expect(localDayEndIso("2026-09-25")).toBe("2026-09-25T23:59:59.999+01:00");
    // Same instant as the local Date — i.e. 23:00Z the previous day, not UTC midnight
    expect(new Date(localDayStartIso("2026-09-25")!).toISOString()).toBe("2026-09-24T23:00:00.000Z");
    expect(new Date(localDayEndIso("2026-09-25")!).toISOString()).toBe("2026-09-25T22:59:59.999Z");
  });

  it("is DST-safe (offset taken at that instant)", () => {
    withTz("Europe/Paris", () => {
      expect(localDayStartIso("2026-07-01")).toBe("2026-07-01T00:00:00.000+02:00");
      expect(localDayStartIso("2026-01-15")).toBe("2026-01-15T00:00:00.000+01:00");
    });
  });

  it("handles negative and fractional offsets", () => {
    withTz("America/New_York", () => {
      expect(localDayEndIso("2026-01-15")).toBe("2026-01-15T23:59:59.999-05:00");
    });
    withTz("Asia/Kolkata", () => {
      expect(toLocalIsoWithOffset(new Date(2026, 0, 1, 0, 0, 0, 0))).toBe("2026-01-01T00:00:00.000+05:30");
    });
  });

  it("rejects empty or invalid dates", () => {
    expect(localDayStartIso("")).toBeNull();
    expect(localDayStartIso("2026-02-30")).toBeNull();
    expect(localDayEndIso("25/09/2026")).toBeNull();
  });

  it("validates ranges", () => {
    expect(isValidDateRange("", "")).toBe(true);
    expect(isValidDateRange("2026-09-01", "")).toBe(true);
    expect(isValidDateRange("2026-09-01", "2026-09-01")).toBe(true);
    expect(isValidDateRange("2026-09-02", "2026-09-01")).toBe(false);
  });
});

describe("small helpers", () => {
  it("shortRef takes the first 8 hex chars uppercased", () => {
    expect(shortRef("a1b2c3d4-e5f6-7890-abcd-ef0123456789")).toBe("A1B2C3D4");
    expect(shortRef("ab-cd-ef-12-34")).toBe("ABCDEF12");
    expect(shortRef(null)).toBe("—");
  });

  it("flags drift above one centime only", () => {
    expect(hasBalanceDrift(1000, 1000)).toBe(false);
    expect(hasBalanceDrift(1000, "1000.01")).toBe(false);
    expect(hasBalanceDrift(1000, 1000.02)).toBe(true);
    expect(hasBalanceDrift("-50", 0)).toBe(true);
  });

  it("links every kind but payments to a sale", () => {
    expect(isSaleLinkedKind("credit_sale")).toBe(true);
    expect(isSaleLinkedKind("refund")).toBe(true);
    expect(isSaleLinkedKind("payment")).toBe(false);
  });

  it("labels all kinds", () => {
    expect(Object.keys(STATEMENT_KIND_LABEL).sort()).toEqual(["card_sale", "cash_sale", "credit_sale", "payment", "refund"]);
  });

  it("plans export batches within the cap", () => {
    expect(statementBatchOffsets(0)).toEqual([]);
    expect(statementBatchOffsets(1)).toEqual([0]);
    expect(statementBatchOffsets(500)).toEqual([0]);
    expect(statementBatchOffsets(501)).toEqual([0, 500]);
    expect(statementBatchOffsets(99_999)).toHaveLength(10); // capped at 5000 rows
    expect(statementBatchOffsets(1200, 500, 1000)).toEqual([0, 500]);
  });

  it("reverses without mutating", () => {
    const src = [3, 2, 1];
    expect(toChronological(src)).toEqual([1, 2, 3]);
    expect(src).toEqual([3, 2, 1]);
  });

  it("escapes CSV cells", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('a "b"')).toBe('"a ""b"""');
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape(12.5)).toBe("12.5");
  });

  it("formats CSV dates in local time", () => {
    expect(formatCsvDateTime("2026-09-24T23:30:00.000Z")).toBe("2026-09-25 00:30");
    expect(formatCsvDateTime("garbage")).toBe("garbage");
  });
});

describe("buildStatementCsv", () => {
  const rows: StatementLine[] = [
    {
      kind: "payment",
      occurred_at: "2026-09-20T10:00:00.000Z",
      reference_id: "bbbbbbbb-0000-0000-0000-000000000000",
      payment_method: null,
      amount: 400,
      debit: 0,
      credit: 400,
      balance_after: 800,
    },
    {
      kind: "credit_sale",
      occurred_at: "2026-09-18T09:15:00.000Z",
      reference_id: "aaaaaaaa-0000-0000-0000-000000000000",
      payment_method: "credit",
      amount: 1200.5,
      debit: 1200.5,
      credit: 0,
      balance_after: 1200,
    },
  ];

  it("starts with a UTF-8 BOM and Arabic headers, oldest first, framed by balances", () => {
    const csv = buildStatementCsv({ rows, openingBalance: -0.5, closingBalance: 800 });
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("التاريخ,النوع,المرجع,المبلغ,مدين,دائن,الرصيد بعد العملية");
    expect(lines[1]).toBe(",رصيد افتتاحي,,,,,-0.5");
    expect(lines[2]).toBe("2026-09-18 10:15,بيع بالكريدي,AAAAAAAA,1200.5,1200.5,0,1200");
    expect(lines[3]).toBe("2026-09-20 11:00,تسديد,BBBBBBBB,400,0,400,800");
    expect(lines[4]).toBe(",رصيد ختامي,,,,,800");
    expect(lines).toHaveLength(5);
  });

  it("does not recompute balances — balance_after is copied as given", () => {
    const csv = buildStatementCsv({ rows: [{ ...rows[0], balance_after: 12345 }], openingBalance: 0, closingBalance: 0 });
    expect(csv).toContain(",12345\r\n");
  });
});
