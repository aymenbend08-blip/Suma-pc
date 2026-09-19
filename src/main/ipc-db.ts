import { ipcMain } from "electron";
import * as db from "./db";

/**
 * Registers every "db:*" IPC channel the renderer's local-db client
 * (renderer/src/lib/localdb.ts) calls. Each handler is a thin pass-through
 * to db.ts — no business logic lives here, just the process boundary.
 */
export function registerDbIpc(): void {
  ipcMain.handle("db:replaceStores", (_e, rows: Record<string, unknown>[]) => db.replaceStores(rows));
  ipcMain.handle("db:replaceStoreMembers", (_e, userId: string, rows: Record<string, unknown>[]) =>
    db.replaceStoreMembers(userId, rows),
  );
  ipcMain.handle("db:replaceProducts", (_e, storeId: string, rows: Record<string, unknown>[]) =>
    db.replaceProducts(storeId, rows),
  );
  ipcMain.handle("db:replaceProductBarcodes", (_e, storeId: string, rows: Record<string, unknown>[]) =>
    db.replaceProductBarcodes(storeId, rows),
  );
  ipcMain.handle("db:replaceCategories", (_e, storeId: string, rows: Record<string, unknown>[]) =>
    db.replaceCategories(storeId, rows),
  );
  ipcMain.handle("db:replaceCustomers", (_e, storeId: string, rows: Record<string, unknown>[]) =>
    db.replaceCustomers(storeId, rows),
  );

  ipcMain.handle("db:searchProducts", (_e, storeId: string, term: string) => db.searchProducts(storeId, term));
  ipcMain.handle("db:findProductByBarcode", (_e, storeId: string, barcode: string) =>
    db.findProductByBarcode(storeId, barcode),
  );
  ipcMain.handle("db:searchCustomers", (_e, storeId: string, term: string) => db.searchCustomers(storeId, term));
  ipcMain.handle("db:listCustomers", (_e, storeId: string) => db.listCustomers(storeId));
  ipcMain.handle("db:getStores", () => db.getStores());
  ipcMain.handle("db:getStoreMembers", (_e, userId: string) => db.getStoreMembers(userId));

  ipcMain.handle("db:createLocalSale", (_e, input: db.LocalSaleInput) => db.createLocalSale(input));
  ipcMain.handle("db:applyLocalCreditPayment", (_e, customerId: string, amount: number) =>
    db.applyLocalCreditPayment(customerId, amount),
  );

  ipcMain.handle("db:enqueueOperation", (_e, operationType: string, payload: unknown) =>
    db.enqueueOperation(operationType, payload),
  );
  ipcMain.handle("db:listPendingSync", () => db.listPendingSync());
  ipcMain.handle("db:countPendingSync", () => db.countPendingSync());
  ipcMain.handle("db:markSyncDone", (_e, id: string) => db.markSyncDone(id));
  ipcMain.handle("db:markSyncFailed", (_e, id: string, error: string) => db.markSyncFailed(id, error));
  ipcMain.handle("db:markSyncRetry", (_e, id: string, error: string) => db.markSyncRetry(id, error));
}
