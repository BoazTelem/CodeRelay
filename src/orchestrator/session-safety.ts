import { ExternalSessionCompatibility, SCHEMA_VERSION, type AgentRole, type SessionPurpose } from "../contracts/schemas.js";
import { sha256 } from "../security/redaction.js";
import type { ProviderEventSummary } from "../providers/types.js";

export interface ReadOnlyToolIsolation {
  executableToolsAvailable: string[];
  undeniedToolAttempts: string[];
  deniedToolAttempts: string[];
  passed: boolean;
}

export function assessReadOnlyToolIsolation(summary: ProviderEventSummary): ReadOnlyToolIsolation {
  const executableToolsAvailable = summary.availableToolNames.filter((name) => name !== "StructuredOutput");
  const deniedToolAttempts = summary.toolNames.filter((name) =>
    summary.toolOutcomes.some((outcome) => outcome.startsWith(`${name}:error`))
  );
  const undeniedToolAttempts = summary.toolNames.filter((name) => !deniedToolAttempts.includes(name));
  return {
    executableToolsAvailable,
    undeniedToolAttempts,
    deniedToolAttempts,
    passed: executableToolsAvailable.length === 0 && undeniedToolAttempts.length === 0
  };
}

export interface SessionIdentity {
  provider: "codex" | "claude";
  nativeSessionId: string;
  repositoryHash: string | null;
  baseCommit: string | null;
  branch: string | null;
  objectiveHash: string | null;
  taskContractHash: string | null;
  priorRole: AgentRole | null;
  purpose: SessionPurpose | null;
  restrictedConfigurationProven: boolean;
}

export interface RequiredSessionIdentity {
  provider: "codex" | "claude";
  repositoryHash: string;
  baseCommit: string;
  branch: string;
  objectiveHash: string;
  taskContractHash: string;
  role: AgentRole;
  purpose: SessionPurpose;
}

export function assessExternalSession(observed: SessionIdentity, required: RequiredSessionIdentity): ExternalSessionCompatibility {
  const checks = {
    repository: observed.repositoryHash === required.repositoryHash,
    baseCommit: observed.baseCommit === required.baseCommit,
    branch: observed.branch === required.branch,
    objective: observed.objectiveHash === required.objectiveHash,
    taskContract: observed.taskContractHash === required.taskContractHash,
    role: observed.priorRole === required.role,
    purpose: observed.purpose === required.purpose,
    restrictedConfiguration: observed.restrictedConfigurationProven
  };
  const reasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => `${name} compatibility was not proven`);
  if (observed.provider !== required.provider) reasons.push("provider mismatch");
  if (observed.priorRole === "WORKER" && (required.role === "AUDITOR" || required.role === "FINAL_VERIFIER")) {
    checks.role = false;
    reasons.push("a prior Worker session cannot become an independent reviewer");
  }
  const compatible = Object.values(checks).every(Boolean) && observed.provider === required.provider;
  return ExternalSessionCompatibility.parse({
    schemaVersion: SCHEMA_VERSION,
    externalSessionIdHash: sha256(observed.nativeSessionId),
    provider: required.provider,
    requestedRole: required.role,
    requestedPurpose: required.purpose,
    compatible,
    nativeSessionEligible: compatible,
    contextBriefOnly: !compatible,
    checks,
    reasons: [...new Set(reasons)],
    evaluatedAt: new Date().toISOString()
  });
}
