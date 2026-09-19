import type {
  CategoryRow,
  CustomerRow,
  ProductBarcodeRow,
  ProductRow,
  StoreMemberRow,
  StoreRow,
} from "./database.types";

/**
 * Typed wrapper around window.suma.db (the IPC bridge to the main-process
 * SQLite mirror). This is the ONE place that casts the untyped IPC
 * results to real row types — everything downstream (POSPage,
 * CustomersPage, the sync engine) calls through here, never
 * window.suma.db directly.
 */
export const localDb = {
  replaceStores: (rows: StoreRow[]) => window.suma.db.replaceStores(rows),
  replaceStoreMembers: (userId: string, rows: StoreMemberRow[]) =>
    window.suma.db.replaceStoreMembers(userId, rows),
  replaceProducts: (storeId: string, rows: ProductRow[]) => window.suma.db.replaceProducts(storeId, rows),
  replaceProductBarcodes: (storeId: string, rows: ProductBarcodeRow[]) =>
    window.suma.db.replaceProductBarcodes(storeId, rows),
  replaceCategories: (storeId: string, rows: CategoryRow[]) => window.suma.db.replaceCategories(storeId, rows),
  replaceCustomers: (storeId: string, rows: CustomerRow[]) => window.suma.db.replaceCustomers(storeId, rows),

  searchProducts: async (storeId: string, term: string): Promise<ProductRow[]> =>
    (await window.suma.db.searchProducts(storeId, term)) as ProductRow[],
  findProductByBarcode: async (storeId: string, barcode: string): Promise<ProductRow | null> =>
    ((await window.suma.db.findProductByBarcode(storeId, barcode)) as ProductRow | null) ?? null,
  searchCustomers: async (storeId: string, term: string): Promise<CustomerRow[]> =>
    (await window.suma.db.searchCustomers(storeId, term)) as CustomerRow[],
  listCustomers: async (storeId: string): Promise<CustomerRow[]> =>
    (await window.suma.db.listCustomers(storeId)) as CustomerRow[],
  getStores: async (): Promise<StoreRow[]> => (await window.suma.db.getStores()) as StoreRow[],
  getStoreMembers: async (userId: string): Promise<StoreMemberRow[]> =>
    (await window.suma.db.getStoreMembers(userId)) as StoreMemberRow[],

  createLocalSale: async (input: LocalSaleInput): Promise<{ id: string; total_amount: number }> =>
    (await window.suma.db.createLocalSale(input)) as { id: string; total_amount: number },
  applyLocalCreditPayment: async (customerId: string, amount: number): Promise<number> =>
    (await window.suma.db.applyLocalCreditPayment(customerId, amount)) as number,

  enqueueOperation: (operationType: string, payload: unknown) =>
    window.suma.db.enqueueOperation(operationType, payload),
  listPendingSync: async (): Promise<SyncQueueItem[]> =>
    (await window.suma.db.listPendingSync()) as SyncQueueItem[],
  countPendingSync: async (): Promise<number> => (await window.suma.db.countPendingSync()) as number,
  markSyncDone: (id: string) => window.suma.db.markSyncDone(id),
  markSyncFailed: (id: string, error: string) => window.suma.db.markSyncFailed(id, error),
  markSyncRetry: (id: string, error: string) => window.suma.db.markSyncRetry(id, error),

  listFailedSync: async (): Promise<SyncQueueItem[]> => (await window.suma.db.listFailedSync()) as SyncQueueItem[],
  countFailedSync: async (): Promise<number> => (await window.suma.db.countFailedSync()) as number,
  retryFailedSync: (id: string) => window.suma.db.retryFailedSync(id),
  dismissFailedSync: (id: string) => window.suma.db.dismissFailedSync(id),
};

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

export type SyncQueueItem = {
  id: string;
  operation_type: string;
  payload: string;
  status: string;
  created_at: string;
  retry_count: number;
  last_error: string | null;
};
