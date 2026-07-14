import type { z } from "zod";
import type {
  AuthenticationProof,
  CustomizationMode,
  ProviderCapabilities,
  ProviderName,
  SessionPurpose
} from "../contracts/schemas.js";

export interface ProviderTurnRequest<T> {
  workItemId: string;
  purpose: SessionPurpose;
  prompt: string;
  outputSchema: z.ZodType<T>;
  schemaName: string;
  access: "read-only" | "workspace-write";
  customizationMode: CustomizationMode;
  cwd: string;
  session?: { mode: "new" } | { mode: "resume-id"; value: string } | { mode: "resume-name"; value: string } | { mode: "latest" };
  timeoutMs: number;
}

export interface ProviderTurnResult<T> {
  provider: ProviderName;
  nativeSessionId: string;
  sessionIdHash: string;
  freshSession: boolean;
  purpose: SessionPurpose;
  output: T;
  eventCount: number;
  rawLogHash: string;
  schemaCorrectionUsed: boolean;
  eventSummary: ProviderEventSummary;
}

export interface ProviderEventSummary {
  types: string[];
  toolNames: string[];
  availableToolNames: string[];
  mcpServerStatuses: string[];
  toolOutcomes: string[];
}

export interface ProviderAdapter {
  readonly provider: ProviderName;
  probe(): Promise<ProviderCapabilities>;
  authenticate(): Promise<AuthenticationProof>;
  runTurn<T>(request: ProviderTurnRequest<T>, signal?: AbortSignal): Promise<ProviderTurnResult<T>>;
  cancel(): Promise<void>;
}
