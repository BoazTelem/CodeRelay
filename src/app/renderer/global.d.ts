export interface ProviderStatusEntry {
  provider: "codex" | "claude";
  available: boolean;
  version?: string;
  authState: string;
}

export interface PreflightSummary {
  canonicalRoot: string;
  currentBranch: string;
  head: string;
  clean: boolean;
  dirtyTracked: string[];
  staged: string[];
  untracked: string[];
  unpushedCommits: number | null;
  requiresUnpushedConfirmation: boolean;
  codeRelayBranches: string[];
}

export interface WorkItemRow {
  id: string;
  title: string;
  primary_root: string;
  branch: string;
  stage: string;
  status: string;
  iteration: number;
  created_at: string;
  updated_at: string;
}

export interface WorkItemEvent {
  sequence: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface WorkItemDetail {
  workItem: WorkItemRow | null;
  events: WorkItemEvent[];
  startError?: string | null;
}

export interface StartWorkItemPayload {
  repository: string;
  instruction: string;
  objective?: string;
  allowedPaths: string[];
  prohibitedPaths?: string[];
  validationCommand?: { executable: string; args: string[] };
  worker: "codex" | "claude";
  confirmedUnpushed?: boolean;
}

export interface CodeRelayApi {
  providerStatus(): Promise<{ codex: ProviderStatusEntry; claude: ProviderStatusEntry }>;
  pickRepository(): Promise<string | null>;
  preflight(repository: string): Promise<PreflightSummary>;
  startWorkItem(payload: StartWorkItemPayload): Promise<{ workItemId: string; branch: string; worker: string; repository: string }>;
  getWorkItem(workItemId: string): Promise<WorkItemDetail>;
  listWorkItems(): Promise<{ workItems: WorkItemRow[] }>;
  pause(workItemId: string): Promise<unknown>;
  resume(workItemId: string): Promise<unknown>;
  intervene(workItemId: string, instruction: string): Promise<unknown>;
}

declare global {
  interface Window {
    coderelay: CodeRelayApi;
  }
}
