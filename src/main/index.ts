import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "path";
import { initDb } from "./db";
import { registerDbIpc } from "./ipc-db";

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

  // Prints the receipt page to the system's default printer (e.g. a
  // thermal 80mm printer set as default on Windows) with no dialog —
  // matches the current SUMA web flow of one click → printed receipt.
  // Real ESC/POS raw printing is a later-phase upgrade, not needed to
  // reuse the existing ReceiptView-style HTML.
  ipcMain.handle("print:silent", async () => {
    if (!mainWindow) return { ok: false, error: "no-window" };
    try {
      await mainWindow.webContents.print({ silent: true, printBackground: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
