import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "path";
import { initDb } from "./db";
import { registerDbIpc } from "./ipc-db";
import { printOffscreenHtml } from "./printing";

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    show: false,
    autoHideMenuBar: true,
    title: "SUMA Desktop",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  mainWindow = win;
  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on("did-fail-load", (_e, code, description) => {
      console.error(`[renderer] failed to load: ${code} ${description}`);
    });
  }

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  app.setAppUserModelId("com.suma.desktop");

  // Electron denies every permission request by default unless a handler
  // says otherwise. The customer voice-search feature needs the mic
  // ("media") — everything else (camera, geolocation, notifications, ...)
  // stays denied, least-privilege, same posture as the sandbox hardening.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  initDb(app.getPath("userData"));
  registerDbIpc();

  // Legacy whole-window print — kept only as a last-resort fallback (see
  // preload/index.ts printReceipt/printLabel, which now print a dedicated
  // offscreen HTML document instead of whatever the cashier has on
  // screen). No remaining call site in the renderer relies on this as the
  // primary path.
  ipcMain.handle("print:silent", async () => {
    if (!mainWindow) return { ok: false, error: "no-window" };
    try {
      await mainWindow.webContents.print({ silent: true, printBackground: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Real, dedicated print paths (Phase A items 1 & 3) — both go through
  // the same offscreen-BrowserWindow helper (main/printing.ts) instead of
  // printing the visible app window. `print:receipt` prints one 80mm
  // receipt document; `print:label` prints one label document N times
  // (native `copies`) at the label's own physical size.
  ipcMain.handle("print:receipt", async (_e, html: string) => {
    // 80mm width, generous continuous-feed length — thermal receipt rolls
    // don't have a fixed page length, this just needs to be tall enough
    // that a normal receipt's content is never truncated.
    return printOffscreenHtml(html, { pageSize: { width: 80000, height: 297000 } });
  });

  ipcMain.handle(
    "print:label",
    async (_e, html: string, opts: { widthMm: number; heightMm: number; copies: number }) => {
      return printOffscreenHtml(html, {
        pageSize: { width: Math.round(opts.widthMm * 1000), height: Math.round(opts.heightMm * 1000) },
        copies: Math.max(1, Math.min(200, Math.round(opts.copies) || 1)),
      });
    },
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
