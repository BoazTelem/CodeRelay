import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UtilityProcessClient } from "./utility-client.js";
import { CHANNELS, InterveneArgs, PreflightArgs, StartWorkItemArgs, WorkItemArgs } from "./ipc-contract.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(moduleDirectory, "..", "..");
const projectRoot = path.resolve(distRoot, "..");

let window: BrowserWindow | undefined;
const utility = new UtilityProcessClient({
  entryScript: path.join(distRoot, "src", "orchestrator", "utility-process.js"),
  dataDirectory: path.join(app.getPath("userData"), "orchestrator"),
  onLog: (line) => console.error(line)
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#101418",
    title: "CodeRelay",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(projectRoot, "dist", "app", "preload.cjs")
    }
  });
  window.removeMenu();
  void window.loadFile(path.join(projectRoot, "dist", "app", "renderer", "index.html"));
  window.on("closed", () => { window = undefined; });
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.providerStatus, async () => await utility.request("provider_status"));
  ipcMain.handle(CHANNELS.pickRepository, async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: "Select a Git repository",
      properties: ["openDirectory"]
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  ipcMain.handle(CHANNELS.preflight, async (_event, raw: unknown) => {
    const args = PreflightArgs.parse(raw);
    return await utility.request("preflight_repository", args);
  });
  ipcMain.handle(CHANNELS.startWorkItem, async (_event, raw: unknown) => {
    const args = StartWorkItemArgs.parse(raw);
    return await utility.request("start_work_item", args);
  });
  ipcMain.handle(CHANNELS.getWorkItem, async (_event, raw: unknown) => {
    const args = WorkItemArgs.parse(raw);
    return await utility.request("get_work_item", args);
  });
  ipcMain.handle(CHANNELS.listWorkItems, async () => await utility.request("list_work_items"));
  ipcMain.handle(CHANNELS.pause, async (_event, raw: unknown) => {
    const args = WorkItemArgs.parse(raw);
    return await utility.request("pause", args);
  });
  ipcMain.handle(CHANNELS.resume, async (_event, raw: unknown) => {
    const args = WorkItemArgs.parse(raw);
    return await utility.request("resume", args);
  });
  ipcMain.handle(CHANNELS.intervene, async (_event, raw: unknown) => {
    const args = InterveneArgs.parse(raw);
    return await utility.request("intervene", args);
  });
}

app.whenReady().then(() => {
  utility.start();
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  void utility.shutdown().finally(() => app.quit());
});
