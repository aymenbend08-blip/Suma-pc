import { describe, expect, it } from "vitest";
import {
  EXPORT_HEADERS,
  TEMPLATE_HEADERS,
  TEMPLATE_ROWS,
  addCounts,
  buildExportRow,
  buildFailedRowsCsv,
  chunk,
  emptyCounts,
  excelSerialToIso,
  guessExtraBarcodeColumns,
  guessMapping,
  mergePreview,
  normalizeHeader,
  parseDateCell,
  parseNumberCell,
  parseNumberLoose,
  prepareRows,
  restoreScientificIntegers,
} from "./productImport";

describe("normalizeHeader", () => {
  it("trims, lowercases, unifies quotes and turns - _ . into spaces", () => {
    expect(normalizeHeader("  Prix d’Achat ")).toBe("prix d'achat");
    expect(normalizeHeader("Prix-Vente_Détail")).toBe("prix vente détail");
    expect(normalizeHeader("stock.quantity")).toBe("stock quantity");
    expect(normalizeHeader("Code   Barres")).toBe("code barres");
  });
});

describe("guessMapping", () => {
  it("maps SUMA Web's own template/export headers", () => {
    const m = guessMapping([...TEMPLATE_HEADERS]);
    expect(m).toMatchObject({
      name: "name",
      barcode: "barcode",
      internal_code: "internal_code",
      selling_price: "selling_price",
      purchase_price: "purchase_price",
      stock_quantity: "stock_quantity",
      unit: "unit",
      category_name: "category_name",
    });
  });

  it("prefers the most specific synonym regardless of column order", () => {
    const m = guessMapping(["Prix Vente", "Désignation", "Prix Vente Détaillant", "Réf", "Code-Barres", "Qté"]);
    expect(m.selling_price).toBe("Prix Vente Détaillant");
    expect(m.name).toBe("Désignation");
    expect(m.internal_code).toBe("Réf");
    expect(m.barcode).toBe("Code-Barres");
    expect(m.stock_quantity).toBe("Qté");
  });

  it("maps Arabic headers and PC's extra fields", () => {
    const m = guessMapping(["اسم المنتج", "الباركود", "سعر البيع", "سعر الشراء", "الكمية", "حد المخزون", "نقاط", "تاريخ الصلاحية", "الوصف", "الفئة"]);
    expect(m).toEqual({
      name: "اسم المنتج",
      barcode: "الباركود",
      selling_price: "سعر البيع",
      purchase_price: "سعر الشراء",
      stock_quantity: "الكمية",
      low_stock_threshold: "حد المخزون",
      points_reward: "نقاط",
      expiry_date: "تاريخ الصلاحية",
      description: "الوصف",
      category_name: "الفئة",
    });
  });

  it("never assigns one column to two fields and leaves unknown headers unmapped", () => {
    const m = guessMapping(["stock", "whatever"]);
    expect(m.stock_quantity).toBe("stock");
    expect(Object.values(m).filter((v) => v === "stock")).toHaveLength(1);
    expect(Object.values(m)).not.toContain("whatever");
  });
});

describe("guessExtraBarcodeColumns", () => {
  it("picks barcode-looking columns other than the main one", () => {
    const headers = ["name", "Barcode", "Barcode 2", "EAN 3", "CB", "extra_barcodes", "code barre bis", "gtin-14", "Prix"];
    expect(guessExtraBarcodeColumns(headers, "Barcode")).toEqual(["Barcode 2", "EAN 3", "CB", "extra_barcodes", "code barre bis", "gtin-14"]);
  });

  it("does not treat words merely containing 'cb'/'ean' as barcode columns", () => {
    expect(guessExtraBarcodeColumns(["ocean", "abcd", "بيان"], undefined)).toEqual([]);
  });
});

describe("parseNumberLoose (SUMA Web rules)", () => {
  it.each([
    ["1200", 1200],
    ["1 200", 1200],
    ["1.200", 1200],
    ["1,200", 1200],
    ["12,5", 12.5],
    ["12.50", 12.5],
    ["1.200,50", 1200.5],
    ["1,200.50", 1200.5],
    ["1.200.000", 1200000],
    ["1,200,000", 1200000],
    ["239.0000", 239],
    // An all-zero 3-digit group is read as decimals (SUMA Web's safer
    // default, so "239.0000"-style padded exports never blow up x1000).
    ["1,000", 1],
    ["1.000", 1],
    ["2,500", 2500],
    ["-5", -5],
    ["-239.0000", -239],
    ["1500 DA", 1500],
    ["DZD 1 500,75", 1500.75],
    ["150 دج", 150],
    ["0", 0],
  ])("%s -> %d", (raw, expected) => {
    expect(parseNumberLoose(raw)).toBe(expected);
  });

  it("returns null for empty or non-numeric input", () => {
    expect(parseNumberLoose("")).toBeNull();
    expect(parseNumberLoose("   ")).toBeNull();
    expect(parseNumberLoose("abc")).toBeNull();
    expect(parseNumberLoose("-")).toBeNull();
    expect(parseNumberLoose(".")).toBeNull();
    expect(parseNumberLoose(null)).toBeNull();
    expect(parseNumberLoose(undefined)).toBeNull();
  });

  it("passes real numbers through", () => {
    expect(parseNumberLoose(42.5)).toBe(42.5);
    expect(parseNumberLoose(Number.NaN)).toBeNull();
  });
});

describe("parseNumberCell", () => {
  it("distinguishes blank from invalid", () => {
    expect(parseNumberCell("")).toEqual({ kind: "empty" });
    expect(parseNumberCell(undefined)).toEqual({ kind: "empty" });
    expect(parseNumberCell("n/a")).toEqual({ kind: "invalid" });
    expect(parseNumberCell("1.200,5")).toEqual({ kind: "ok", value: 1200.5 });
  });
});

describe("dates", () => {
  it("parses ISO, DD/MM/YYYY and 2-digit years", () => {
    expect(parseDateCell("2026-09-25")).toEqual({ kind: "ok", value: "2026-09-25" });
    expect(parseDateCell("2026/9/5")).toEqual({ kind: "ok", value: "2026-09-05" });
    expect(parseDateCell("25/09/2026")).toEqual({ kind: "ok", value: "2026-09-25" });
    expect(parseDateCell("5-9-2026")).toEqual({ kind: "ok", value: "2026-09-05" });
    expect(parseDateCell("25.09.26")).toEqual({ kind: "ok", value: "2026-09-25" });
  });

  it("parses Excel serial numbers (as number or text)", () => {
    expect(excelSerialToIso(45000)).toBe("2023-03-15");
    expect(excelSerialToIso(1)).toBe("1900-01-01");
    expect(excelSerialToIso(59)).toBe("1900-02-28");
    expect(excelSerialToIso(60)).toBeNull();
    expect(excelSerialToIso(61)).toBe("1900-03-01");
    expect(parseDateCell(46290)).toEqual({ kind: "ok", value: "2026-09-25" });
    expect(parseDateCell("46290")).toEqual({ kind: "ok", value: "2026-09-25" });
  });

  it("rejects impossible or garbage dates, and treats blank as empty", () => {
    expect(parseDateCell("31/02/2026")).toEqual({ kind: "invalid" });
    expect(parseDateCell("2026-13-01")).toEqual({ kind: "invalid" });
    expect(parseDateCell("demain")).toEqual({ kind: "invalid" });
    expect(parseDateCell("")).toEqual({ kind: "empty" });
  });
});

describe("prepareRows", () => {
  const mapping = guessMapping([...TEMPLATE_HEADERS, "expiry", "points"]);
  const extras = guessExtraBarcodeColumns([...TEMPLATE_HEADERS], mapping.barcode);

  function row(values: Record<string, unknown>) {
    return { name: "", barcode: "", extra_barcodes: "", internal_code: "", selling_price: "", purchase_price: "", stock_quantity: "", unit: "", category_name: "", ...values };
  }

  it("builds payloads with numbers as numbers and only the provided fields", () => {
    const { rows } = prepareRows(
      [row({ name: "  حليب   1 لتر ", barcode: "0061300", selling_price: "1.200,50", stock_quantity: "40", category_name: "ألبان", expiry: "25/12/2026", points: "3" })],
      mapping,
      extras,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].payload).toEqual({
      row: 2,
      name: "حليب 1 لتر",
      barcode: "0061300", // leading zeros kept
      selling_price: 1200.5,
      stock_quantity: 40,
      category_name: "ألبان",
      expiry_date: "2026-12-25",
      points_reward: 3,
    });
  });

  it("splits extra barcodes on , ; | , drops invalid ones with a note and de-duplicates against the main barcode", () => {
    const { rows } = prepareRows([row({ name: "A", barcode: "111", extra_barcodes: "222; 333|111, bad code!,222" })], mapping, extras);
    expect(rows[0].payload.barcode).toBe("111");
    expect(rows[0].payload.extra_barcodes).toEqual(["222", "333"]);
    expect(rows[0].notes.some((n) => n.includes("badcode!"))).toBe(true);
    expect(rows[0].errors).toEqual([]);
  });

  it("promotes the first extra barcode to main when the main cell is empty", () => {
    const { rows } = prepareRows([row({ name: "A", extra_barcodes: "444,555" })], mapping, extras);
    expect(rows[0].payload.barcode).toBe("444");
    expect(rows[0].payload.extra_barcodes).toEqual(["555"]);
  });

  it("skips empty-name rows and counts total rows as skipped", () => {
    const res = prepareRows(
      [row({ name: "A" }), row({ selling_price: "5" }), row({ name: "Total" }), row({ name: "المجموع" }), row({ name: "Grand-Total" })],
      mapping,
      extras,
    );
    expect(res.rows.map((r) => r.payload.name)).toEqual(["A"]);
    expect(res.skippedEmpty).toBe(1);
    expect(res.skippedTotals.map((t) => t.line)).toEqual([4, 5, 6]);
  });

  it("flags an unparseable non-empty number instead of silently nulling it", () => {
    const { rows } = prepareRows([row({ name: "A", selling_price: "gratuit", stock_quantity: "" })], mapping, extras);
    expect(rows[0].errors[0]).toContain("سعر البيع غير صالح");
    expect(rows[0].payload).not.toHaveProperty("selling_price");
    expect(rows[0].payload).not.toHaveProperty("stock_quantity");
  });

  it("flags invalid barcodes, negative prices, bad points and bad dates", () => {
    const { rows } = prepareRows(
      [
        row({ name: "A", barcode: "12 34 é" }),
        row({ name: "B", selling_price: "-5" }),
        row({ name: "C", points: "2.5" }),
        row({ name: "D", expiry: "31/02/2026" }),
      ],
      mapping,
      extras,
    );
    expect(rows[0].errors[0]).toContain("باركود غير صالح");
    expect(rows[1].errors[0]).toContain("سعر البيع");
    expect(rows[2].errors[0]).toContain("نقاط الولاء");
    expect(rows[3].errors[0]).toContain("تاريخ الصلاحية");
  });

  it("flags ALL occurrences of a main barcode duplicated inside the file", () => {
    const { rows } = prepareRows([row({ name: "A", barcode: "999" }), row({ name: "B", barcode: "123" }), row({ name: "C", barcode: "999" })], mapping, extras);
    expect(rows[0].errors[0]).toContain("باركود مكرر داخل الملف");
    expect(rows[0].errors[0]).toContain("2، 4");
    expect(rows[1].errors).toEqual([]);
    expect(rows[2].errors[0]).toContain("باركود مكرر داخل الملف");
  });

  it("merges same-name lines into ONE product, their barcodes becoming extra barcodes (SUMA Web grouping)", () => {
    const { rows } = prepareRows(
      [
        row({ name: "Coca 1L", barcode: "111", selling_price: "150", stock_quantity: "10" }),
        row({ name: "Other", barcode: "999" }),
        row({ name: "coca 1l", barcode: "222", stock_quantity: "10", category_name: "Boissons" }),
        row({ name: "COCA 1L", barcode: "111", extra_barcodes: "333", selling_price: "150", stock_quantity: "10" }),
      ],
      mapping,
      extras,
    );
    expect(rows.map((r) => r.payload.name)).toEqual(["Coca 1L", "Other"]);
    const coca = rows[0];
    expect(coca.errors).toEqual([]); // the repeated 111 is the same product, not an in-file duplicate
    expect(coca.payload.barcode).toBe("111");
    expect(coca.payload.extra_barcodes).toEqual(["222", "333"]);
    expect(coca.payload.selling_price).toBe(150);
    expect(coca.payload.stock_quantity).toBe(10); // never summed
    expect(coca.payload.category_name).toBe("Boissons"); // blank filled from a later line
    expect(coca.mergedLines).toEqual([4, 5]);
    expect(coca.notes[0]).toContain("دُمجت معه الأسطر 4، 5");
  });

  it("keeps same-name lines that disagree on price or stock separate and flags both", () => {
    const { rows } = prepareRows(
      [row({ name: "Sucre", selling_price: "100" }), row({ name: "sucre", selling_price: "120" }), row({ name: "SUCRE", stock_quantity: "7" })],
      mapping,
      extras,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
    expect(rows[0].notes.some((n) => n.includes("ما تدمجوش"))).toBe(true);
    expect(rows[1].notes.some((n) => n.includes("ما تدمجوش"))).toBe(true);
    expect(rows[2].notes.some((n) => n.includes("ما تدمجوش"))).toBe(true);
    // No barcode and no code: the server matches them by name, so the
    // "same product" note from the in-file check is still there too.
    expect(rows[0].notes.some((n) => n.includes("سيُعتبر نفس المنتج"))).toBe(true);
  });

  it("never merges lines with different internal codes or with a client error", () => {
    const { rows } = prepareRows(
      [
        row({ name: "Riz", internal_code: "R1", barcode: "501" }),
        row({ name: "riz", internal_code: "R2", barcode: "502" }),
        row({ name: "riz", barcode: "bad code é" }),
      ],
      mapping,
      extras,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].payload.extra_barcodes).toBeUndefined();
    expect(rows[1].payload.barcode).toBe("502");
    expect(rows[2].errors[0]).toContain("باركود غير صالح");
  });

  it("merges blank-stock lines (blank counts as 0, SUMA Web rule) and promotes a barcode when the leader had none", () => {
    const { rows } = prepareRows([row({ name: "Pain" }), row({ name: "pain", barcode: "777" })], mapping, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.barcode).toBe("777");
    expect(rows[0].payload.extra_barcodes).toBeUndefined();
  });

  it("uses SheetJS's __rowNum__ for the line number when present", () => {
    const r = row({ name: "A" });
    Object.defineProperty(r, "__rowNum__", { value: 9, enumerable: false });
    expect(prepareRows([r], mapping, extras).rows[0].line).toBe(10);
  });
});

describe("mergePreview", () => {
  const mapping = guessMapping([...TEMPLATE_HEADERS]);
  const { rows } = prepareRows(
    [
      { name: "New", barcode: "1" },
      { name: "Existing", barcode: "2", selling_price: "10" },
      { name: "Bad", barcode: "3", selling_price: "x" },
      { name: "Server says no", barcode: "4" },
    ],
    mapping,
    [],
  );

  it("combines client errors with dry-run verdicts and warnings by line", () => {
    const preview = mergePreview(rows, {
      results: [
        { row: 2, name: "New", status: "created" },
        { row: 3, name: "Existing", status: "updated", matched_by: "barcode" },
        { row: 5, name: "Server says no", status: "error", reason: "تغيير السعر محجوز لصاحب المحل فقط" },
      ],
      warnings: [{ row: 2, note: "تصنيف جديد: X" }],
    });
    expect(preview.map((p) => [p.line, p.status, p.importable])).toEqual([
      [2, "new", true],
      [3, "update", true],
      [4, "error", false],
      [5, "error", false],
    ]);
    expect(preview[0].warnings).toEqual(["تصنيف جديد: X"]);
    expect(preview[1].sellingPrice).toBe(10);
    expect(preview[2].reason).toContain("سعر البيع غير صالح");
    expect(preview[3].reason).toContain("محجوز");
  });

  it("treats a row the server didn't answer for as an error", () => {
    const preview = mergePreview(rows.slice(0, 1), { results: [], warnings: [] });
    expect(preview[0].status).toBe("error");
    expect(preview[0].importable).toBe(false);
  });
});

describe("helpers", () => {
  it("chunk splits into fixed-size pieces", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 500)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });

  it("addCounts aggregates chunk results", () => {
    const total = addCounts(addCounts(emptyCounts(), { created: 2, failed: 1 }), { created: 1, updated: 4, barcode_only: 1, skipped: 2 });
    expect(total).toEqual({ created: 3, updated: 4, skipped: 2, barcode_only: 1, failed: 1 });
  });

  it("builds the failed-rows CSV with a BOM, Arabic headers and escaping", () => {
    const csv = buildFailedRowsCsv([
      { line: 3, name: 'Lait "UHT", 1L', reason: "باركود مكرر" },
      { line: 7, name: "Sucre", reason: "سطر\nثاني" },
    ]);
    expect(csv.startsWith("﻿السطر,الاسم,السبب\r\n")).toBe(true);
    expect(csv).toContain('3,"Lait ""UHT"", 1L",باركود مكرر');
    expect(csv).toContain('7,Sucre,"سطر\nثاني"');
  });

  it("template matches SUMA Web's headers and sample rows", () => {
    expect([...TEMPLATE_HEADERS]).toEqual(["name", "barcode", "extra_barcodes", "internal_code", "selling_price", "purchase_price", "stock_quantity", "unit", "category_name"]);
    expect(TEMPLATE_ROWS).toHaveLength(2);
    for (const r of TEMPLATE_ROWS) expect(Object.keys(r)).toEqual([...TEMPLATE_HEADERS]);
  });

  it("export rows re-import cleanly through the auto-mapping", () => {
    const exported = buildExportRow(
      { id: "p1", name: "حليب", internal_code: "S1", category_id: "c1", purchase_price: 90, selling_price: 120, stock_quantity: 7, barcode: "00123", unit: "علبة" },
      new Map([["c1", "ألبان"]]),
      new Map([["p1", ["A1", "B2"]]]),
    );
    expect(Object.keys(exported)).toEqual([...EXPORT_HEADERS]);
    const headers = [...EXPORT_HEADERS];
    const mapping = guessMapping(headers);
    const stringRow = Object.fromEntries(Object.entries(exported).map(([k, v]) => [k, String(v)]));
    const { rows } = prepareRows([stringRow], mapping, guessExtraBarcodeColumns(headers, mapping.barcode));
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].payload).toEqual({
      row: 2,
      name: "حليب",
      barcode: "00123",
      extra_barcodes: ["A1", "B2"],
      internal_code: "S1",
      selling_price: 120,
      purchase_price: 90,
      stock_quantity: 7,
      unit: "علبة",
      category_name: "ألبان",
    });
  });
});

describe("restoreScientificIntegers", () => {
  it("restores full digits for integer cells shown in scientific notation only", () => {
    const sheet: Record<string, unknown> = {
      "!ref": "A1:D2",
      A2: { t: "n", v: 6130001112223, w: "6.13E+12" },
      B2: { t: "n", v: 1200.5, w: "1200.5" },
      C2: { t: "n", v: 1.5e-7, w: "1.5E-07" },
      D2: { t: "n", v: 12345678901234567890, w: "1.23457E+19" },
      E2: { t: "s", v: "6.13E+12", w: "6.13E+12" },
    };
    expect(restoreScientificIntegers(sheet)).toBe(1);
    expect((sheet.A2 as { w: string }).w).toBe("6130001112223");
    expect((sheet.B2 as { w: string }).w).toBe("1200.5");
    expect((sheet.C2 as { w: string }).w).toBe("1.5E-07");
    expect((sheet.D2 as { w: string }).w).toBe("1.23457E+19");
    expect((sheet.E2 as { w: string }).w).toBe("6.13E+12");
  });
});
