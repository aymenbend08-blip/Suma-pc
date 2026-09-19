import { app, BrowserWindow } from "electron";
import { join } from "path";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { preload: join(__dirname, "../out/preload/index.js") },
  });

  win.webContents.on("console-message", (_e, _level, message) => {
    console.log("[renderer]", message);
  });
  win.webContents.on("did-fail-load", (_e, code, description) => {
    console.error("[did-fail-load]", code, description);
  });

  await win.loadFile(join(__dirname, "../out/renderer/index.html"));
  await new Promise((r) => setTimeout(r, 2500));

  const image = await win.webContents.capturePage();
  writeFileSync(join(__dirname, "../screenshot.png"), image.toPNG());
  console.log("SCREENSHOT_SAVED");
  app.quit();
});
