import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const product = db.findProductByBarcode("store-1", "1234567890") as { stock_quantity: number };
    expect(product.stock_quantity).toBe(3);

    const pending = db.listPendingSync();
    expect(pending).toHaveLength(1);
    expect(pending[0].operation_type).toBe("record_sale");
    const payload = JSON.parse(pending[0].payload) as { _client_request_id: string };
    expect(payload._client_request_id).toBe("req-1");
  });

  it("rejects a line exceeding local stock and leaves everything untouched", () => {
    seedProduct({ stock_quantity: 2 });

    expect(() =>
      db.createLocalSale({
        id: "sale-2",
        storeId: "store-1",
        cashierId: "cashier-1",
        cashierName: null,
        items: [{ productId: "prod-1", quantity: 5 }],
        discount: 0,
        paymentMethod: "cash",
        customerId: null,
        clientRequestId: "req-2",
      }),
    ).toThrow(/أكبر من المخزون المتوفر محليًا/);

    const product = db.findProductByBarcode("store-1", "1234567890") as { stock_quantity: number };
    expect(product.stock_quantity).toBe(2); // unchanged
    expect(db.listPendingSync()).toHaveLength(0); // nothing enqueued
  });

  it("rolls back the whole cart when only the second line is oversold", () => {
    // replaceProducts replaces the whole store's product set in one call
    // (it DELETEs by store_id first) — both fixtures must be seeded
    // together, not via two separate seedProduct() calls.
    db.replaceProducts("store-1", [
      seedProductRow({ id: "prod-1", barcode: "1111", stock_quantity: 10 }),
      seedProductRow({ id: "prod-2", barcode: "2222", stock_quantity: 1 }),
    ]);

    expect(() =>
      db.createLocalSale({
        id: "sale-3",
        storeId: "store-1",
        cashierId: "cashier-1",
        cashierName: null,
        items: [
          { productId: "prod-1", quantity: 3 },
          { productId: "prod-2", quantity: 5 },
        ],
        discount: 0,
        paymentMethod: "cash",
        customerId: null,
        clientRequestId: "req-3",
      }),
    ).toThrow();

    // prod-1's stock must be unchanged even though it was processed
    // first in the loop, before the rejection on prod-2.
    const firstProduct = db.findProductByBarcode("store-1", "1111") as { stock_quantity: number };
    expect(firstProduct.stock_quantity).toBe(10);
    expect(db.listPendingSync()).toHaveLength(0);
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
