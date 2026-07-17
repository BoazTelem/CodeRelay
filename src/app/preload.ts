import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "./ipc-contract.js";

const api = {
  providerStatus: () => ipcRenderer.invoke(CHANNELS.providerStatus),
  probeClaudeUsage: () => ipcRenderer.invoke(CHANNELS.probeClaudeUsage),
  pickRepository: () => ipcRenderer.invoke(CHANNELS.pickRepository),
  preflight: (repository: string) => ipcRenderer.invoke(CHANNELS.preflight, { repository }),
  startWorkItem: (payload: unknown) => ipcRenderer.invoke(CHANNELS.startWorkItem, payload),
  getWorkItem: (workItemId: string) => ipcRenderer.invoke(CHANNELS.getWorkItem, { workItemId }),
  listWorkItems: () => ipcRenderer.invoke(CHANNELS.listWorkItems),
  pause: (workItemId: string) => ipcRenderer.invoke(CHANNELS.pause, { workItemId }),
  resume: (workItemId: string) => ipcRenderer.invoke(CHANNELS.resume, { workItemId }),
  intervene: (workItemId: string, instruction: string) => ipcRenderer.invoke(CHANNELS.intervene, { workItemId, instruction })
};

export type CodeRelayApi = typeof api;

contextBridge.exposeInMainWorld("coderelay", api);
