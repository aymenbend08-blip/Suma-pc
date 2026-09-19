import { contextBridge, ipcRenderer } from "electron";

// Minimal, explicit surface exposed to the renderer — no direct Node/OS
// access is given to the web content, only these specific calls.
const api = {
  printSilent: () => ipcRenderer.invoke("print:silent"),
};

contextBridge.exposeInMainWorld("suma", api);

export type SumaApi = typeof api;
