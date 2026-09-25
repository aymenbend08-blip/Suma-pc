import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as db from "./db";

// Exercises the real db.ts against a real (temp, on-disk) SQLite file —
// no mocking of better-sqlite3 or the schema. db.ts has no Electron
// imports, so this runs the exact same code the app's main process runs,
// just outside Electron.

let tempDir: string;

function seedProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prod-1",
    store_id: "store-1",
    name: "منتج تجريبي",
    description: null,
    barcode: "1234567890",
    internal_code: null,
    purchase_price: 50,
    selling_price: 100,
    stock_quantity: 5,
    low_stock_threshold: 2,
    unit: "قطعة",
    category_id: null,
    image_url: null,
    points_reward: 0,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_low_stock: false,
    expiry_date: null,
    ...overrides,
  };
}

function seedProduct(overrides: Partial<Record<string, unknown>> = {}) {
  const product = seedProductRow(overrides);
  db.replaceProducts("store-1", [product]);
  return product;
}

function seedCustomer(overrides: Partial<Record<string, unknown>> = {}) {
  const customer = {
    id: "cust-1",
    store_id: "store-1",
    full_name: "زبون تجريبي",
    phone: "0555000000",
    status: "approved",
    points_balance: 0,
    credit_balance: 1000,
    credit_since: null,
    approved_by: null,
    approved_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  db.replaceCustomers("store-1", [customer]);
  return customer;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "suma-db-test-"));
  db.initDb(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createLocalSale", () => {
  it("records a sale and decrements stock by the sold quantity", () => {
    seedProduct({ stock_quantity: 5 });
    const result = db.createLocalSale({
      id: "sale-1",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: "كاشير",
      items: [{ productId: "prod-1", quantity: 2 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-1",
    });

    expect(result.total_amount).toBe(200);
    const product = db.findProductByBarcode("store-1", "1234567890") as unknown as { stock_quantity: number };
    expect(product.stock_quantity).toBe(3);

    const pending = db.listPendingSync();
    expect(pending).toHaveLength(1);
    expect(pending[0].operation_type).toBe("record_sale");
    const payload = JSON.parse(pending[0].payload) as { _client_request_id: string };
    expect(payload._client_request_id).toBe("req-1");
  });

  it("allows overselling and lets stock go negative (business decision, not a bug)", () => {
    seedProduct({ stock_quantity: 2 });

    const result = db.createLocalSale({
      id: "sale-2",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 5 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-2",
    });

    expect(result.total_amount).toBe(500); // full quantity charged, not clamped
    const product = db.findProductByBarcode("store-1", "1234567890") as unknown as { stock_quantity: number };
    expect(product.stock_quantity).toBe(-3); // real deficit, not floored at 0
    expect(db.listPendingSync()).toHaveLength(1);
  });

  it("a second oversold sale keeps compounding the negative stock correctly", () => {
    seedProduct({ stock_quantity: 2 });
    db.createLocalSale({
      id: "sale-3a",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 5 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-3a",
    });
    db.createLocalSale({
      id: "sale-3b",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 4 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-3b",
    });

    const product = db.findProductByBarcode("store-1", "1234567890") as unknown as { stock_quantity: number };
    expect(product.stock_quantity).toBe(-7); // 2 - 5 - 4
  });

  it("freezes the price into the sync_queue payload at the moment of the offline sale", () => {
    seedProduct({ stock_quantity: 10, selling_price: 300 });
    db.createLocalSale({
      id: "sale-5",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 1 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-5",
    });

    const pending = db.listPendingSync();
    const payload = JSON.parse(pending[0].payload) as {
      _items: Array<{ product_id: string; quantity: number; unit_price: number }>;
    };
    expect(payload._items).toEqual([{ product_id: "prod-1", quantity: 1, unit_price: 300 }]);
  });

  it("sends the real offline sale moment as _occurred_at, so a later sync doesn't misdate it", () => {
    seedProduct({ stock_quantity: 10, selling_price: 300 });
    const before = Date.now();
    db.createLocalSale({
      id: "sale-occurred",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 1 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-occurred",
    });
    const after = Date.now();

    const pending = db.listPendingSync();
    const payload = JSON.parse(pending[0].payload) as { _occurred_at: string };
    const occurredAtMs = new Date(payload._occurred_at).getTime();
    // Captured at the moment of the actual (offline) sale, not left for
    // record_sale() to stamp with its own now() whenever this eventually
    // syncs — which could be hours or days later.
    expect(occurredAtMs).toBeGreaterThanOrEqual(before);
    expect(occurredAtMs).toBeLessThanOrEqual(after);
  });

  it("keeps the already-enqueued price frozen even after the local product price changes later", () => {
    // Simulates: offline sale at 300, then a hydrate() cycle (still
    // offline-to-sync, but pulling fresher reference data some other way,
    // or just the next price update reaching this device) overwrites the
    // local product row's price to 350 BEFORE this queued sale syncs.
    seedProduct({ stock_quantity: 10, selling_price: 300 });
    db.createLocalSale({
      id: "sale-6",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 1 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-6",
    });

    // Price changes locally AFTER the sale was already queued.
    seedProduct({ stock_quantity: 10, selling_price: 350 });

    const pending = db.listPendingSync();
    const payload = JSON.parse(pending[0].payload) as {
      _items: Array<{ product_id: string; quantity: number; unit_price: number }>;
    };
    // Still 300 — the queued payload was never re-read or re-priced.
    expect(payload._items[0].unit_price).toBe(300);
  });

  it("increases the customer's local credit balance by the sale total, atomically with the rest of the sale", () => {
    seedProduct({ stock_quantity: 10, selling_price: 250 });
    seedCustomer({ credit_balance: 1000 });

    const result = db.createLocalSale({
      id: "sale-credit-1",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: "كاشير",
      items: [{ productId: "prod-1", quantity: 2 }],
      discount: 0,
      paymentMethod: "credit",
      customerId: "cust-1",
      clientRequestId: "req-credit-1",
    });

    expect(result.total_amount).toBe(500);

    const customers = db.listCustomers("store-1") as { credit_balance: number }[];
    expect(customers[0].credit_balance).toBe(1500); // 1000 + 500, delta-based

    const product = db.findProductByBarcode("store-1", "1234567890") as unknown as { stock_quantity: number };
    expect(product.stock_quantity).toBe(8); // stock still decremented as usual

    const pending = db.listPendingSync();
    expect(pending).toHaveLength(1);
    expect(pending[0].operation_type).toBe("record_sale");
    const payload = JSON.parse(pending[0].payload) as { _customer_id: string; _payment_method: string };
    expect(payload._customer_id).toBe("cust-1");
    expect(payload._payment_method).toBe("credit");
  });

  it("does not touch customer credit for cash or card sales, even with a customer attached", () => {
    seedProduct({ stock_quantity: 10, selling_price: 250 });
    seedCustomer({ credit_balance: 1000 });

    db.createLocalSale({
      id: "sale-cash-1",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 1 }],
      discount: 0,
      paymentMethod: "cash",
      customerId: "cust-1",
      clientRequestId: "req-cash-1",
    });
    db.createLocalSale({
      id: "sale-card-1",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 1 }],
      discount: 0,
      paymentMethod: "card",
      customerId: "cust-1",
      clientRequestId: "req-card-1",
    });

    const customers = db.listCustomers("store-1") as { credit_balance: number }[];
    expect(customers[0].credit_balance).toBe(1000); // unchanged by cash/card sales
  });

  it("rolls back the credit-balance update along with the rest of the sale if an item is invalid", () => {
    seedProduct({ stock_quantity: 10, selling_price: 250 });
    seedCustomer({ credit_balance: 1000 });

    expect(() =>
      db.createLocalSale({
        id: "sale-credit-fail",
        storeId: "store-1",
        cashierId: "cashier-1",
        cashierName: null,
        items: [
          { productId: "prod-1", quantity: 1 },
          { productId: "does-not-exist", quantity: 1 },
        ],
        discount: 0,
        paymentMethod: "credit",
        customerId: "cust-1",
        clientRequestId: "req-credit-fail",
      }),
    ).toThrow(/منتج غير معروف محليًا/);

    const customers = db.listCustomers("store-1") as { credit_balance: number }[];
    expect(customers[0].credit_balance).toBe(1000); // untouched — the whole transaction rolled back
    const product = db.findProductByBarcode("store-1", "1234567890") as unknown as { stock_quantity: number };
    expect(product.stock_quantity).toBe(10); // stock decrement for prod-1 rolled back too
    expect(db.listPendingSync()).toHaveLength(0); // nothing enqueued either
  });

  it("throws for a product unknown to the local mirror", () => {
    expect(() =>
      db.createLocalSale({
        id: "sale-4",
        storeId: "store-1",
        cashierId: "cashier-1",
        cashierName: null,
        items: [{ productId: "does-not-exist", quantity: 1 }],
        discount: 0,
        paymentMethod: "cash",
        customerId: null,
        clientRequestId: "req-4",
      }),
    ).toThrow(/منتج غير معروف محليًا/);
  });
});

describe("applyLocalCreditPayment", () => {
  it("applies a valid payment and returns the new balance", () => {
    seedCustomer({ credit_balance: 1000 });
    const newBalance = db.applyLocalCreditPayment("cust-1", 200);
    expect(newBalance).toBe(800);
  });

  it("rejects a payment exceeding the local balance and leaves it untouched", () => {
    seedCustomer({ credit_balance: 1000 });
    expect(() => db.applyLocalCreditPayment("cust-1", 1500)).toThrow(/أكبر من الدّين المعروف محليًا/);

    const customers = db.listCustomers("store-1") as { credit_balance: number }[];
    expect(customers[0].credit_balance).toBe(1000); // unchanged
  });

  it("throws for an unknown customer", () => {
    expect(() => db.applyLocalCreditPayment("does-not-exist", 100)).toThrow(/زبون غير معروف محليًا/);
  });
});

describe("sync_queue lifecycle", () => {
  it("moves an item through pending -> failed -> retried (back to pending)", () => {
    const id = db.enqueueOperation("pay_customer_credit", { _amount: 300 });
    expect(db.listPendingSync().map((r) => r.id)).toContain(id);
    expect(db.countPendingSync()).toBe(1);

    db.markSyncFailed(id, "المبلغ أكبر من الدّين المتبقي على هذا الزبون.");
    expect(db.listPendingSync()).toHaveLength(0);
    expect(db.listFailedSync().map((r) => r.id)).toContain(id);
    expect(db.countFailedSync()).toBe(1);

    db.retryFailedSync(id);
    expect(db.listFailedSync()).toHaveLength(0);
    const pending = db.listPendingSync();
    expect(pending).toHaveLength(1);
    expect(pending[0].last_error).toBeNull();
  });

  it("dismiss removes an item from both pending and failed views, keeping the row", () => {
    const id = db.enqueueOperation("record_sale", {});
    db.markSyncFailed(id, "خطأ ما");
    db.dismissFailedSync(id);

    expect(db.listPendingSync()).toHaveLength(0);
    expect(db.listFailedSync()).toHaveLength(0);
    expect(db.countPendingSync()).toBe(0);
    expect(db.countFailedSync()).toBe(0);
  });

  it("markSyncDone removes an item from the pending list", () => {
    const id = db.enqueueOperation("record_sale", {});
    db.markSyncDone(id);
    expect(db.listPendingSync()).toHaveLength(0);
  });

  it("markSyncRetry keeps an item pending but records the error and bumps retry_count", () => {
    const id = db.enqueueOperation("record_sale", {});
    db.markSyncRetry(id, "TypeError: Failed to fetch");
    const pending = db.listPendingSync();
    expect(pending).toHaveLength(1);
    expect(pending[0].last_error).toBe("TypeError: Failed to fetch");
    expect(pending[0].retry_count).toBe(1);
  });
});

function seedVariant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "var-1",
    product_id: "prod-1",
    store_id: "store-1",
    variant_name: "أحمر",
    barcode: "VAR-RED-1",
    selling_price: null,
    stock_quantity: null,
    image_url: null,
    attributes: { اللون: "أحمر" },
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("product_variants mirror", () => {
  it("replaceProductVariants fully replaces the store's variants and leaves other stores alone", () => {
    seedProduct();
    db.replaceProductVariants("store-1", [seedVariant(), seedVariant({ id: "var-2", barcode: "VAR-BLUE-1", variant_name: "أزرق" })]);
    db.replaceProductVariants("store-2", [seedVariant({ id: "var-other", store_id: "store-2", barcode: "OTHER-1" })]);

    expect((db.findProductByBarcode("store-1", "VAR-BLUE-1") as db.BarcodeMatch).matched_variant_id).toBe("var-2");

    // Second hydrate for store-1 drops var-2 — it must stop resolving.
    db.replaceProductVariants("store-1", [seedVariant()]);
    expect(db.findProductByBarcode("store-1", "VAR-BLUE-1")).toBeNull();
    expect(db.findProductByBarcode("store-1", "VAR-RED-1")?.matched_variant_id).toBe("var-1");
    // store-2's variant was never touched by store-1's replace (its product
    // simply isn't mirrored here, so it resolves to nothing — but the row
    // survives, proven by re-seeding the product for store-2).
    db.replaceProducts("store-2", [seedProductRow({ id: "prod-1b", store_id: "store-2", barcode: "P2" })]);
    db.replaceProductVariants("store-2", [seedVariant({ id: "var-other", store_id: "store-2", product_id: "prod-1b", barcode: "OTHER-1" })]);
    expect(db.findProductByBarcode("store-2", "OTHER-1")?.id).toBe("prod-1b");
  });

  it("upgrades an existing pre-variants database file without touching its data", () => {
    seedProduct();
    // Simulate an install from before this table existed.
    const raw = new Database(join(tempDir, "suma-desktop.db"));
    raw.exec("DROP TABLE product_variants");
    raw.close();

    db.initDb(tempDir); // next app launch on the same file
    expect(db.findProductByBarcode("store-1", "1234567890")?.id).toBe("prod-1");
    db.replaceProductVariants("store-1", [seedVariant()]);
    expect(db.findProductByBarcode("store-1", "VAR-RED-1")?.id).toBe("prod-1");
  });
});

describe("findProductByBarcode — 3-step resolution", () => {
  beforeEach(() => {
    db.replaceProducts("store-1", [
      seedProductRow({ id: "prod-main", barcode: "111111" }),
      seedProductRow({ id: "prod-alias", barcode: "222222", name: "منتج باركود إضافي" }),
      seedProductRow({ id: "prod-var", barcode: "333333", name: "منتج بتنويعات" }),
    ]);
    db.replaceProductBarcodes("store-1", [
      { id: "bc-1", product_id: "prod-alias", store_id: "store-1", barcode: "ALIAS-1", note: null, created_at: "" },
    ]);
    db.replaceProductVariants("store-1", [
      seedVariant({ id: "var-a", product_id: "prod-var", barcode: "VAR-A", variant_name: "كبير" }),
      seedVariant({ id: "var-off", product_id: "prod-var", barcode: "VAR-OFF", variant_name: "قديم", is_active: false }),
    ]);
  });

  it("1) main barcode resolves to the product with no variant", () => {
    const hit = db.findProductByBarcode("store-1", "111111");
    expect(hit?.id).toBe("prod-main");
    expect(hit?.matched_variant_id).toBeNull();
    expect(hit?.matched_variant_name).toBeNull();
  });

  it("2) extra barcode resolves to its parent product", () => {
    const hit = db.findProductByBarcode("store-1", "ALIAS-1");
    expect(hit?.id).toBe("prod-alias");
    expect(hit?.matched_variant_id).toBeNull();
  });

  it("3) active variant barcode resolves to the BASE product and reports the variant", () => {
    const hit = db.findProductByBarcode("store-1", "VAR-A");
    expect(hit?.id).toBe("prod-var");
    expect(hit?.selling_price).toBe(100); // base product's price
    expect(hit?.matched_variant_id).toBe("var-a");
    expect(hit?.matched_variant_name).toBe("كبير");
  });

  it("ignores an inactive variant", () => {
    expect(db.findProductByBarcode("store-1", "VAR-OFF")).toBeNull();
  });

  it("prefers the main barcode over an (inconsistent, stale) alias or variant with the same code", () => {
    db.replaceProductBarcodes("store-1", [
      { id: "bc-dup", product_id: "prod-alias", store_id: "store-1", barcode: "111111", note: null, created_at: "" },
    ]);
    db.replaceProductVariants("store-1", [seedVariant({ id: "var-dup", product_id: "prod-var", barcode: "111111" })]);
    expect(db.findProductByBarcode("store-1", "111111")?.id).toBe("prod-main");

    db.replaceProducts("store-1", [
      seedProductRow({ id: "prod-alias", barcode: "222222" }),
      seedProductRow({ id: "prod-var", barcode: "333333" }),
    ]);
    // With no main-barcode owner left, the alias wins over the variant.
    expect(db.findProductByBarcode("store-1", "111111")?.id).toBe("prod-alias");
  });

  it("returns null for an unknown or blank code, and trims the scanned value", () => {
    expect(db.findProductByBarcode("store-1", "NOPE")).toBeNull();
    expect(db.findProductByBarcode("store-1", "   ")).toBeNull();
    expect(db.findProductByBarcode("store-1", " VAR-A ")?.matched_variant_id).toBe("var-a");
  });
});

describe("searchProducts", () => {
  beforeEach(() => {
    db.replaceProducts("store-1", [
      seedProductRow({ id: "p-a", name: "حليب", barcode: "5000" }),
      seedProductRow({ id: "p-b", name: "قهوة", barcode: "6000" }),
      seedProductRow({ id: "p-c", name: "شاي", barcode: "7000" }),
    ]);
    db.replaceProductBarcodes("store-1", [
      { id: "bc-1", product_id: "p-b", store_id: "store-1", barcode: "EXTRA-998877", note: null, created_at: "" },
    ]);
    db.replaceProductVariants("store-1", [
      seedVariant({ id: "v-1", product_id: "p-c", barcode: "VARIANT-445566" }),
      seedVariant({ id: "v-2", product_id: "p-a", barcode: "OFFVAR-112233", is_active: false }),
    ]);
  });

  it("matches a product through a partial extra barcode", () => {
    const rows = db.searchProducts("store-1", "998877") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["p-b"]);
  });

  it("matches a product through a partial active variant barcode", () => {
    const rows = db.searchProducts("store-1", "445566") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["p-c"]);
  });

  it("does not match through an inactive variant's barcode", () => {
    expect(db.searchProducts("store-1", "112233")).toHaveLength(0);
  });

  it("still matches by name and returns each product once", () => {
    const rows = db.searchProducts("store-1", "قهوة") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["p-b"]);
  });
});

describe("createLocalSale — variants", () => {
  it("passes variant_id into the queued record_sale payload and stores the variant on the local line, at the base price/stock", () => {
    seedProduct({ stock_quantity: 10, selling_price: 300 });
    db.replaceProductVariants("store-1", [seedVariant()]);

    db.createLocalSale({
      id: "sale-var-1",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [
        { productId: "prod-1", quantity: 2, variantId: "var-1" },
        { productId: "prod-1", quantity: 1 },
      ],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-var-1",
    });

    const payload = JSON.parse(db.listPendingSync()[0].payload) as {
      _items: Array<Record<string, unknown>>;
      _occurred_at: string;
      _client_request_id: string;
    };
    expect(payload._items).toEqual([
      { product_id: "prod-1", variant_id: "var-1", quantity: 2, unit_price: 300 },
      { product_id: "prod-1", quantity: 1, unit_price: 300 },
    ]);
    expect(typeof payload._occurred_at).toBe("string");
    expect(payload._client_request_id).toBe("req-var-1");

    // Base stock took both lines (variants share the parent's stock).
    expect(db.findProductByBarcode("store-1", "1234567890")?.stock_quantity).toBe(7);

    // Local sale_items carry the variant trace (read through a second
    // connection on the same file — db.ts exposes no sale_items reader).
    const raw = new Database(join(tempDir, "suma-desktop.db"), { readonly: true });
    const lines = raw
      .prepare("SELECT variant_id, variant_name, unit_price FROM sale_items WHERE sale_id = ? ORDER BY quantity DESC")
      .all("sale-var-1");
    raw.close();
    expect(lines).toEqual([
      { variant_id: "var-1", variant_name: "أحمر", unit_price: 300 },
      { variant_id: null, variant_name: null, unit_price: 300 },
    ]);
  });

  it("still forwards an unknown variant id (the server ignores it) without failing the sale", () => {
    seedProduct({ stock_quantity: 10, selling_price: 300 });
    const res = db.createLocalSale({
      id: "sale-var-2",
      storeId: "store-1",
      cashierId: "cashier-1",
      cashierName: null,
      items: [{ productId: "prod-1", quantity: 1, variantId: "gone-variant" }],
      discount: 0,
      paymentMethod: "cash",
      customerId: null,
      clientRequestId: "req-var-2",
    });
    expect(res.total_amount).toBe(300);
    const payload = JSON.parse(db.listPendingSync()[0].payload) as { _items: Array<Record<string, unknown>> };
    expect(payload._items[0].variant_id).toBe("gone-variant");
  });

  it("refuses a product that has no selling price, writing nothing", () => {
    seedProduct({ selling_price: null });
    expect(() =>
      db.createLocalSale({
        id: "sale-noprice",
        storeId: "store-1",
        cashierId: "cashier-1",
        cashierName: null,
        items: [{ productId: "prod-1", quantity: 1 }],
        discount: 0,
        paymentMethod: "cash",
        customerId: null,
        clientRequestId: "req-noprice",
      }),
    ).toThrow(/بدون سعر بيع/);
    expect(db.listPendingSync()).toHaveLength(0);
  });
});
