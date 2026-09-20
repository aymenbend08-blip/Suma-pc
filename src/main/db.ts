import Database from "better-sqlite3";
import { join } from "path";

/**
 * Local SQLite mirror — lives only in the Electron main process (native
 * module, never exposed to the renderer directly; see preload/index.ts
 * for the IPC surface that touches it). This is a CACHE + a small
 * outbox, not a second source of truth: real financial/stock state
 * always lives in Supabase. Reference tables (products, customers, ...)
 * get overwritten wholesale on every hydrate cycle — at SUMA's current
 * scale (a few thousand rows per store) a full re-pull is simpler and
 * safe than tracking per-row incremental sync, and it sidesteps needing
 * an `updated_at` column SUMA's `customers` table doesn't have yet.
 */

let db: Database.Database | null = null;

export function initDb(userDataPath: string): void {
  db = new Database(join(userDataPath, "suma-desktop.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY, owner_id TEXT, store_name TEXT, public_identifier TEXT,
      wilaya TEXT, commune TEXT, address TEXT, phone TEXT, logo_url TEXT,
      business_type TEXT, store_size TEXT, is_public INTEGER, is_active INTEGER,
      show_stock_to_customers INTEGER, created_at TEXT, updated_at TEXT,
      tax_rate REAL, receipt_footer TEXT, working_hours TEXT, credit_limit REAL,
      credit_overdue_days INTEGER, receipt_show_qr INTEGER
    );

    CREATE TABLE IF NOT EXISTS store_members (
      id TEXT PRIMARY KEY, store_id TEXT, user_id TEXT, role TEXT, full_name TEXT,
      phone TEXT, can_update_price INTEGER, can_manage_products INTEGER,
      can_print_labels INTEGER, is_active INTEGER, created_at TEXT, updated_at TEXT,
      can_use_pos INTEGER, can_refund INTEGER, can_manage_customers INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_store_members_user ON store_members(user_id);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, store_id TEXT, name TEXT, description TEXT, barcode TEXT,
      internal_code TEXT, purchase_price REAL, selling_price REAL, stock_quantity REAL,
      low_stock_threshold REAL, unit TEXT, category_id TEXT, image_url TEXT,
      points_reward INTEGER, is_active INTEGER, created_at TEXT, updated_at TEXT,
      is_low_stock INTEGER, expiry_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(store_id, barcode);

    CREATE TABLE IF NOT EXISTS product_barcodes (
      id TEXT PRIMARY KEY, product_id TEXT, store_id TEXT, barcode TEXT, note TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_product_barcodes_lookup ON product_barcodes(store_id, barcode);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, store_id TEXT, name TEXT, sort_order INTEGER,
      created_at TEXT, is_active INTEGER
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, store_id TEXT, full_name TEXT, phone TEXT, status TEXT,
      points_balance REAL, credit_balance REAL, credit_since TEXT,
      approved_by TEXT, approved_at TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_customers_store ON customers(store_id, status);

    -- Local record of sales made while offline (and, for convenience, a
    -- cache of the last-seen online sales too). Never read as the
    -- authoritative total for accounting — that stays server-side.
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY, store_id TEXT, cashier_id TEXT, cashier_name TEXT,
      total_amount REAL, item_count INTEGER, created_at TEXT, discount_amount REAL,
      payment_method TEXT, refunded_amount REAL, refunded_at TEXT, refunded_by TEXT,
      customer_id TEXT, client_request_id TEXT, is_local INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sales_store ON sales(store_id, created_at);

    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY, sale_id TEXT, product_id TEXT, product_name TEXT,
      quantity REAL, unit_price REAL, line_total REAL, variant_id TEXT,
      variant_name TEXT, refunded_quantity REAL
    );
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

    -- The outbox: one row per operation attempted while offline (or that
    -- failed to reach Supabase). The sync engine (renderer-side, since
    -- that's where the authenticated Supabase client lives) drains this
    -- by replaying "payload" against the real RPC of the same name —
    -- never by pushing a raw table value, so it's exactly as safe against
    -- concurrent edits as an online call would be.
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, created_at);
  `);
}

function getDb(): Database.Database {
  if (!db) throw new Error("Local database not initialized");
  return db;
}

function bool(v: unknown): number {
  return v ? 1 : 0;
}

// ---- Reference-table hydration (full replace-per-store) ----------------

export function replaceStores(rows: Record<string, unknown>[]): void {
  const d = getDb();
  const insert = d.prepare(`
    INSERT INTO stores (id, owner_id, store_name, public_identifier, wilaya, commune, address, phone,
      logo_url, business_type, store_size, is_public, is_active, show_stock_to_customers, created_at,
      updated_at, tax_rate, receipt_footer, working_hours, credit_limit, credit_overdue_days, receipt_show_qr)
    VALUES (@id, @owner_id, @store_name, @public_identifier, @wilaya, @commune, @address, @phone,
      @logo_url, @business_type, @store_size, @is_public, @is_active, @show_stock_to_customers, @created_at,
      @updated_at, @tax_rate, @receipt_footer, @working_hours, @credit_limit, @credit_overdue_days, @receipt_show_qr)
    ON CONFLICT(id) DO UPDATE SET
      store_name=excluded.store_name, public_identifier=excluded.public_identifier, wilaya=excluded.wilaya,
      commune=excluded.commune, address=excluded.address, phone=excluded.phone, logo_url=excluded.logo_url,
      business_type=excluded.business_type, store_size=excluded.store_size, is_public=excluded.is_public,
      is_active=excluded.is_active, show_stock_to_customers=excluded.show_stock_to_customers,
      updated_at=excluded.updated_at, tax_rate=excluded.tax_rate, receipt_footer=excluded.receipt_footer,
      working_hours=excluded.working_hours, credit_limit=excluded.credit_limit,
      credit_overdue_days=excluded.credit_overdue_days, receipt_show_qr=excluded.receipt_show_qr
  `);
  const tx = d.transaction((items: Record<string, unknown>[]) => {
    for (const r of items) {
      insert.run({
        ...r,
        is_public: bool(r["is_public"]),
        is_active: bool(r["is_active"]),
        show_stock_to_customers: bool(r["show_stock_to_customers"]),
        receipt_show_qr: bool(r["receipt_show_qr"]),
      });
    }
  });
  tx(rows);
}

export function replaceStoreMembers(userId: string, rows: Record<string, unknown>[]): void {
  const d = getDb();
  const del = d.prepare("DELETE FROM store_members WHERE user_id = ?");
  const insert = d.prepare(`
    INSERT INTO store_members (id, store_id, user_id, role, full_name, phone, can_update_price,
      can_manage_products, can_print_labels, is_active, created_at, updated_at, can_use_pos,
      can_refund, can_manage_customers)
    VALUES (@id, @store_id, @user_id, @role, @full_name, @phone, @can_update_price,
      @can_manage_products, @can_print_labels, @is_active, @created_at, @updated_at, @can_use_pos,
      @can_refund, @can_manage_customers)
  `);
  const tx = d.transaction((items: Record<string, unknown>[]) => {
    del.run(userId);
    for (const r of items) {
      insert.run({
        ...r,
        can_update_price: bool(r["can_update_price"]),
        can_manage_products: bool(r["can_manage_products"]),
        can_print_labels: bool(r["can_print_labels"]),
        is_active: bool(r["is_active"]),
        can_use_pos: bool(r["can_use_pos"]),
        can_refund: bool(r["can_refund"]),
        can_manage_customers: bool(r["can_manage_customers"]),
      });
    }
  });
  tx(rows);
}

export function replaceProducts(storeId: string, rows: Record<string, unknown>[]): void {
  const d = getDb();
  const del = d.prepare("DELETE FROM products WHERE store_id = ?");
  const insert = d.prepare(`
    INSERT INTO products (id, store_id, name, description, barcode, internal_code, purchase_price,
      selling_price, stock_quantity, low_stock_threshold, unit, category_id, image_url, points_reward,
      is_active, created_at, updated_at, is_low_stock, expiry_date)
    VALUES (@id, @store_id, @name, @description, @barcode, @internal_code, @purchase_price,
      @selling_price, @stock_quantity, @low_stock_threshold, @unit, @category_id, @image_url,
      @points_reward, @is_active, @created_at, @updated_at, @is_low_stock, @expiry_date)
  `);
  const tx = d.transaction((items: Record<string, unknown>[]) => {
    del.run(storeId);
    for (const r of items) {
      insert.run({ ...r, is_active: bool(r["is_active"]), is_low_stock: bool(r["is_low_stock"]) });
    }
  });
  tx(rows);
}

export function replaceProductBarcodes(storeId: string, rows: Record<string, unknown>[]): void {
  const d = getDb();
  const del = d.prepare("DELETE FROM product_barcodes WHERE store_id = ?");
  const insert = d.prepare(`
    INSERT INTO product_barcodes (id, product_id, store_id, barcode, note, created_at)
    VALUES (@id, @product_id, @store_id, @barcode, @note, @created_at)
  `);
  const tx = d.transaction((items: Record<string, unknown>[]) => {
    del.run(storeId);
    for (const r of items) insert.run(r);
  });
  tx(rows);
}

export function replaceCategories(storeId: string, rows: Record<string, unknown>[]): void {
  const d = getDb();
  const del = d.prepare("DELETE FROM categories WHERE store_id = ?");
  const insert = d.prepare(`
    INSERT INTO categories (id, store_id, name, sort_order, created_at, is_active)
    VALUES (@id, @store_id, @name, @sort_order, @created_at, @is_active)
  `);
  const tx = d.transaction((items: Record<string, unknown>[]) => {
    del.run(storeId);
    for (const r of items) insert.run({ ...r, is_active: bool(r["is_active"]) });
  });
  tx(rows);
}

export function replaceCustomers(storeId: string, rows: Record<string, unknown>[]): void {
  const d = getDb();
  const del = d.prepare("DELETE FROM customers WHERE store_id = ?");
  const insert = d.prepare(`
    INSERT INTO customers (id, store_id, full_name, phone, status, points_balance, credit_balance,
      credit_since, approved_by, approved_at, created_at)
    VALUES (@id, @store_id, @full_name, @phone, @status, @points_balance, @credit_balance,
      @credit_since, @approved_by, @approved_at, @created_at)
  `);
  const tx = d.transaction((items: Record<string, unknown>[]) => {
    del.run(storeId);
    for (const r of items) insert.run(r);
  });
  tx(rows);
}

// ---- Local reads (what the renderer actually queries against) ----------

export function searchProducts(storeId: string, term: string, limit = 20): unknown[] {
  const d = getDb();
  const like = `%${term.replace(/[%_]/g, "")}%`;
  return d
    .prepare(
      `SELECT * FROM products
       WHERE store_id = ? AND is_active = 1
         AND (name LIKE ? OR barcode LIKE ? OR internal_code LIKE ?)
       ORDER BY name LIMIT ?`,
    )
    .all(storeId, like, like, like, limit);
}

export function findProductByBarcode(storeId: string, barcode: string): unknown {
  const d = getDb();
  const direct = d
    .prepare("SELECT * FROM products WHERE store_id = ? AND barcode = ? LIMIT 1")
    .get(storeId, barcode);
  if (direct) return direct;
  const alias = d
    .prepare("SELECT product_id FROM product_barcodes WHERE store_id = ? AND barcode = ? LIMIT 1")
    .get(storeId, barcode) as { product_id: string } | undefined;
  if (!alias) return null;
  return d.prepare("SELECT * FROM products WHERE id = ?").get(alias.product_id) ?? null;
}

export function searchCustomers(storeId: string, term: string, limit = 20): unknown[] {
  const d = getDb();
  const like = `%${term.replace(/[%_]/g, "")}%`;
  return d
    .prepare(
      `SELECT * FROM customers
       WHERE store_id = ? AND status = 'approved' AND (full_name LIKE ? OR phone LIKE ?)
       ORDER BY full_name LIMIT ?`,
    )
    .all(storeId, like, like, limit);
}

export function listCustomers(storeId: string): unknown[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM customers WHERE store_id = ? AND status = 'approved' ORDER BY full_name")
    .all(storeId);
}

export function getStores(): unknown[] {
  return getDb().prepare("SELECT * FROM stores ORDER BY created_at").all();
}

export function getStoreMembers(userId: string): unknown[] {
  return getDb().prepare("SELECT * FROM store_members WHERE user_id = ?").all(userId);
}

// ---- Offline write path: local sale + outbox ----------------------------

export type LocalSaleInput = {
  id: string;
  storeId: string;
  cashierId: string;
  cashierName: string | null;
  items: Array<{ productId: string; quantity: number }>;
  discount: number;
  paymentMethod: "cash" | "card" | "credit";
  customerId: string | null;
  clientRequestId: string;
};

/**
 * Writes a sale entirely offline: computed from the locally cached
 * product prices (best information available), stock decremented
 * locally so the next search reflects it, and queues the exact same
 * record_sale() RPC call for replay once back online. Never touches
 * Supabase directly — that happens later, in the renderer's sync loop.
 */
export function createLocalSale(input: LocalSaleInput): { id: string; total_amount: number } {
  const d = getDb();
  const getProduct = d.prepare("SELECT * FROM products WHERE id = ?");
  const updateStock = d.prepare("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?");
  const addCredit = d.prepare("UPDATE customers SET credit_balance = credit_balance + ? WHERE id = ?");
  const insertSale = d.prepare(`
    INSERT INTO sales (id, store_id, cashier_id, cashier_name, total_amount, item_count, created_at,
      discount_amount, payment_method, refunded_amount, refunded_at, refunded_by, customer_id,
      client_request_id, is_local)
    VALUES (@id, @store_id, @cashier_id, @cashier_name, @total_amount, @item_count, @created_at,
      @discount_amount, @payment_method, 0, NULL, NULL, @customer_id, @client_request_id, 1)
  `);
  const insertItem = d.prepare(`
    INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, unit_price, line_total,
      variant_id, variant_name, refunded_quantity)
    VALUES (@id, @sale_id, @product_id, @product_name, @quantity, @unit_price, @line_total, NULL, NULL, 0)
  `);
  const enqueue = d.prepare(`
    INSERT INTO sync_queue (id, operation_type, payload, status, created_at, retry_count)
    VALUES (?, 'record_sale', ?, 'pending', ?, 0)
  `);

  const tx = d.transaction(() => {
    let subtotal = 0;
    let itemCount = 0;
    const lineRows: Array<{
      id: string;
      sale_id: string;
      product_id: string;
      product_name: string;
      quantity: number;
      unit_price: number;
      line_total: number;
    }> = [];

    for (const item of input.items) {
      const product = getProduct.get(item.productId) as
        | { id: string; name: string; selling_price: number; stock_quantity: number }
        | undefined;
      if (!product) throw new Error(`منتج غير معروف محليًا: ${item.productId}`);
      // Overselling is allowed on purpose (matches record_sale()'s
      // 20260919200000 migration) — stock_quantity is left to go
      // negative below, never rejected or floored.
      const lineTotal = Number(product.selling_price) * item.quantity;
      subtotal += lineTotal;
      itemCount += item.quantity;
      lineRows.push({
        id: cryptoRandomId(),
        sale_id: input.id,
        product_id: product.id,
        product_name: product.name,
        quantity: item.quantity,
        unit_price: Number(product.selling_price),
        line_total: lineTotal,
      });
      updateStock.run(item.quantity, item.productId);
    }

    const totalAmount = Math.max(0, subtotal - input.discount);
    const nowIso = new Date().toISOString();

    insertSale.run({
      id: input.id,
      store_id: input.storeId,
      cashier_id: input.cashierId,
      cashier_name: input.cashierName,
      total_amount: totalAmount,
      item_count: itemCount,
      created_at: nowIso,
      discount_amount: input.discount,
      payment_method: input.paymentMethod,
      customer_id: input.customerId,
      client_request_id: input.clientRequestId,
    });
    for (const row of lineRows) insertItem.run(row);

    // A credit sale increases what the customer owes locally by the same
    // delta record_sale() will apply server-side once this syncs — never
    // an absolute overwrite, and part of the same transaction as the rest
    // of the sale so the local mirror can't end up with the sale recorded
    // but the debt missed (or vice versa) if something throws mid-way.
    if (input.paymentMethod === "credit" && input.customerId) {
      addCredit.run(totalAmount, input.customerId);
    }

    // The price charged offline is frozen here (lineRows.unit_price, read
    // from the local mirror at THIS moment) and sent explicitly with the
    // replay — record_sale() honors a supplied unit_price instead of
    // re-reading its own current selling_price. Without this, a price
    // change on another device before this synced would silently charge
    // the server-side total at the NEW price while the cashier already
    // collected cash at the old one, with nothing ever surfacing the
    // mismatch (see the 20260919210000 migration for the server side).
    enqueue.run(
      cryptoRandomId(),
      JSON.stringify({
        _store_id: input.storeId,
        _items: lineRows.map((r) => ({ product_id: r.product_id, quantity: r.quantity, unit_price: r.unit_price })),
        _discount: input.discount,
        _payment_method: input.paymentMethod,
        ...(input.customerId ? { _customer_id: input.customerId } : {}),
        _client_request_id: input.clientRequestId,
      }),
      nowIso,
    );

    return { id: input.id, total_amount: totalAmount };
  });

  return tx();
}

function cryptoRandomId(): string {
  // Node's crypto is always available in the main process (unlike the
  // renderer, which needs the secure-context fallback in lib/uuid.ts).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("crypto").randomUUID();
}

// ---- Sync queue management (driven by the renderer's sync loop) --------

export type SyncQueueItem = {
  id: string;
  operation_type: string;
  payload: string;
  status: string;
  created_at: string;
  retry_count: number;
  last_error: string | null;
};

/**
 * Local mirror of pay_customer_credit()'s effect — a delta, not an
 * absolute value, same reasoning as createLocalSale's stock decrement:
 * safe to apply now and reconcile against server truth on the next
 * hydrate() even if another device also touched this customer meanwhile.
 */
export function applyLocalCreditPayment(customerId: string, amount: number): number {
  const d = getDb();
  const customer = d.prepare("SELECT credit_balance FROM customers WHERE id = ?").get(customerId) as
    | { credit_balance: number }
    | undefined;
  if (!customer) throw new Error("زبون غير معروف محليًا.");
  // Mirrors pay_customer_credit()'s server-side rejection of an
  // overpayment — same reasoning as createLocalSale's stock check: catch
  // it locally instead of only discovering the rejection at sync time.
  if (amount > Number(customer.credit_balance)) {
    throw new Error(
      `المبلغ (${amount}) أكبر من الدّين المعروف محليًا (${customer.credit_balance}) على هذا الزبون.`,
    );
  }
  d.prepare("UPDATE customers SET credit_balance = credit_balance - ? WHERE id = ?").run(amount, customerId);
  const row = d.prepare("SELECT credit_balance FROM customers WHERE id = ?").get(customerId) as
    | { credit_balance: number }
    | undefined;
  return row?.credit_balance ?? 0;
}

export function enqueueOperation(operationType: string, payload: unknown): string {
  const id = cryptoRandomId();
  getDb()
    .prepare(
      "INSERT INTO sync_queue (id, operation_type, payload, status, created_at, retry_count) VALUES (?, ?, ?, 'pending', ?, 0)",
    )
    .run(id, operationType, JSON.stringify(payload), new Date().toISOString());
  return id;
}

export function listPendingSync(): SyncQueueItem[] {
  return getDb()
    .prepare("SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at")
    .all() as SyncQueueItem[];
}

export function countPendingSync(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as n FROM sync_queue WHERE status = 'pending'")
    .get() as { n: number };
  return row.n;
}

export function markSyncDone(id: string): void {
  getDb().prepare("UPDATE sync_queue SET status = 'done' WHERE id = ?").run(id);
}

export function markSyncFailed(id: string, error: string): void {
  getDb()
    .prepare(
      "UPDATE sync_queue SET status = 'failed', last_error = ?, retry_count = retry_count + 1 WHERE id = ?",
    )
    .run(error, id);
}

export function markSyncRetry(id: string, error: string): void {
  getDb()
    .prepare("UPDATE sync_queue SET last_error = ?, retry_count = retry_count + 1 WHERE id = ?")
    .run(error, id);
}

// ---- Failed-sync review (the owner's only way to ever see a permanently
// rejected offline operation — previously nothing beyond a toast at the
// moment of failure) --------------------------------------------------

export function listFailedSync(): SyncQueueItem[] {
  return getDb()
    .prepare("SELECT * FROM sync_queue WHERE status = 'failed' ORDER BY created_at DESC")
    .all() as SyncQueueItem[];
}

export function countFailedSync(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as n FROM sync_queue WHERE status = 'failed'")
    .get() as { n: number };
  return row.n;
}

/** Puts a failed item back in the queue for the sync engine to retry —
 * e.g. the owner topped up stock or approved the customer manually and
 * wants this same operation re-sent now. */
export function retryFailedSync(id: string): void {
  getDb()
    .prepare("UPDATE sync_queue SET status = 'pending', last_error = NULL WHERE id = ? AND status = 'failed'")
    .run(id);
}

/** Acknowledges a failed item without retrying it — the owner reconciled
 * it some other way (or decided it doesn't matter) and wants it off the
 * review list. Kept as a row (status = 'dismissed'), never deleted, so
 * the audit trail survives. */
export function dismissFailedSync(id: string): void {
  getDb()
    .prepare("UPDATE sync_queue SET status = 'dismissed' WHERE id = ? AND status = 'failed'")
    .run(id);
}
