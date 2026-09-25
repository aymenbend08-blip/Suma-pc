import { contextBridge, ipcRenderer } from "electron";

// Minimal, explicit surface exposed to the renderer — no direct Node/OS
// access is given to the web content, only these specific calls. The
// `db` group is a thin IPC pass-through to the main-process SQLite mirror
// (src/main/db.ts) — the renderer's src/renderer/src/lib/localdb.ts is
// where these untyped IPC results get their real TypeScript shape.
const api = {
  printSilent: () => ipcRenderer.invoke("print:silent"),
  /** Prints a fully self-contained receipt HTML document in an offscreen
   * window — decoupled from whatever's on screen (see main/printing.ts). */
  printReceipt: (html: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("print:receipt", html),
  /** Prints a label HTML document `copies` times at its own physical
   * size (widthMm × heightMm) — one call covers "print N copies of this
   * label" via the native print `copies` option. */
  printLabel: (
    html: string,
    opts: { widthMm: number; heightMm: number; copies: number },
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("print:label", html, opts),

  db: {
    replaceStores: (rows: unknown[]) => ipcRenderer.invoke("db:replaceStores", rows),
    replaceStoreMembers: (userId: string, rows: unknown[]) =>
      ipcRenderer.invoke("db:replaceStoreMembers", userId, rows),
    replaceProducts: (storeId: string, rows: unknown[]) =>
      ipcRenderer.invoke("db:replaceProducts", storeId, rows),
    replaceProductBarcodes: (storeId: string, rows: unknown[]) =>
      ipcRenderer.invoke("db:replaceProductBarcodes", storeId, rows),
    replaceProductVariants: (storeId: string, rows: unknown[]) =>
      ipcRenderer.invoke("db:replaceProductVariants", storeId, rows),
    replaceCategories: (storeId: string, rows: unknown[]) =>
      ipcRenderer.invoke("db:replaceCategories", storeId, rows),
    replaceCustomers: (storeId: string, rows: unknown[]) =>
      ipcRenderer.invoke("db:replaceCustomers", storeId, rows),

    searchProducts: (storeId: string, term: string) => ipcRenderer.invoke("db:searchProducts", storeId, term),
    findProductByBarcode: (storeId: string, barcode: string) =>
      ipcRenderer.invoke("db:findProductByBarcode", storeId, barcode),
    searchCustomers: (storeId: string, term: string) => ipcRenderer.invoke("db:searchCustomers", storeId, term),
    listCustomers: (storeId: string) => ipcRenderer.invoke("db:listCustomers", storeId),
    getStores: () => ipcRenderer.invoke("db:getStores"),
    getStoreMembers: (userId: string) => ipcRenderer.invoke("db:getStoreMembers", userId),

    createLocalSale: (input: unknown) => ipcRenderer.invoke("db:createLocalSale", input),
    applyLocalCreditPayment: (customerId: string, amount: number) =>
      ipcRenderer.invoke("db:applyLocalCreditPayment", customerId, amount),

    enqueueOperation: (operationType: string, payload: unknown) =>
      ipcRenderer.invoke("db:enqueueOperation", operationType, payload),
    listPendingSync: () => ipcRenderer.invoke("db:listPendingSync"),
    countPendingSync: () => ipcRenderer.invoke("db:countPendingSync"),
    markSyncDone: (id: string) => ipcRenderer.invoke("db:markSyncDone", id),
    markSyncFailed: (id: string, error: string) => ipcRenderer.invoke("db:markSyncFailed", id, error),
    markSyncRetry: (id: string, error: string) => ipcRenderer.invoke("db:markSyncRetry", id, error),

    listFailedSync: () => ipcRenderer.invoke("db:listFailedSync"),
    countFailedSync: () => ipcRenderer.invoke("db:countFailedSync"),
    retryFailedSync: (id: string) => ipcRenderer.invoke("db:retryFailedSync", id),
    dismissFailedSync: (id: string) => ipcRenderer.invoke("db:dismissFailedSync", id),
  },
};

contextBridge.exposeInMainWorld("suma", api);

export type SumaApi = typeof api;
