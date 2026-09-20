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
    const product = db.findProductByBarcode("store-1", "1234567890") as { stock_quantity: number };
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

    const product = db.findProductByBarcode("store-1", "1234567890") as { stock_quantity: number };
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

    const product = db.findProductByBarcode("store-1", "1234567890") as { stock_quantity: number };
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
    const product = db.findProductByBarcode("store-1", "1234567890") as { stock_quantity: number };
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
