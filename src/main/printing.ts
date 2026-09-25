import { BrowserWindow } from "electron";

/**
 * Shared offscreen-print helper — Phase A item 1 (receipts) and item 3
 * (labels) both go through this ONE function rather than duplicating the
 * "spin up a hidden window, load HTML, print silently, tear it down"
 * dance. Decoupled from the visible app window (unlike the old
 * `print:silent`, which printed whatever the cashier currently had on
 * screen) — a receipt or a sheet of labels always prints exactly the
 * generated HTML it was given, regardless of what page is open.
 */
export type PrintOptions = {
  /** Physical page size in microns (1 mm = 1000 microns). Omitted for the
   * printer's/OS's own default paper size. */
  pageSize?: { width: number; height: number };
  /** Same physical page printed N times (used for label quantity/repeat
   * printing) — cheaper and simpler than generating N near-identical
   * pages of HTML. */
  copies?: number;
};

export async function printOffscreenHtml(
  html: string,
  options: PrintOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    await win.webContents.print({
      silent: true,
      printBackground: true,
      margins: { marginType: "none" },
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
      ...(options.copies ? { copies: options.copies } : {}),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
