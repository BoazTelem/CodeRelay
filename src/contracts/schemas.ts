import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

export const ProviderName = z.enum(["codex", "claude", "stub-codex", "stub-claude"]);
export type ProviderName = z.infer<typeof ProviderName>;

export const ProviderAuthState = z.enum([
  "SUBSCRIPTION_VERIFIED",
  "API_BILLING_DETECTED",
  "AUTHENTICATED_BUT_MODE_UNKNOWN",
  "NOT_AUTHENTICATED",
  "PROVIDER_UNAVAILABLE"
]);
export type ProviderAuthState = z.infer<typeof ProviderAuthState>;

export const AuthenticationProof = z.object({
  state: ProviderAuthState,
  command: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  observedFieldNames: z.array(z.string()),
  stdoutRedacted: z.string(),
  stderrRedacted: z.string(),
  evidenceHash: z.string(),
  probedAt: z.string().datetime()
}).strict();
export type AuthenticationProof = z.infer<typeof AuthenticationProof>;

const CapabilityResult = z.object({
  supported: z.boolean(),
  evidenceRef: z.string().optional(),
  reason: z.string().optional()
}).strict();

export const ProviderCapabilities = z.object({
  schemaVersion: SchemaVersion,
  provider: ProviderName,
  platform: z.string(),
  executable: z.object({
    available: z.boolean(),
    resolvedPathHash: z.string().optional(),
    version: z.string().optional(),
    error: z.string().optional()
  }).strict(),
  authentication: AuthenticationProof,
  structuredOutput: CapabilityResult.extend({ schemaEnforced: z.boolean() }),
  resume: z.object({
    exactId: z.boolean(),
    name: z.boolean(),
    latest: z.boolean(),
    nativePicker: z.boolean()
  }).strict(),
  customizationIsolation: CapabilityResult.extend({
    repositoryInstructionsSuppressed: z.boolean(),
    managedPolicyMayApply: z.boolean()
  }),
  toolRestriction: CapabilityResult.extend({ brokerOnly: z.boolean() }),
  sandboxing: z.object({
    readOnly: z.boolean(),
    workspaceWrite: z.boolean(),
    outsideWorktreeDenied: z.boolean(),
    evidenceRef: z.string().optional()
  }).strict(),
  cancellation: z.object({
    graceful: z.boolean(),
    processTree: z.boolean(),
    evidenceRef: z.string().optional()
  }).strict(),
  knownIncompatibilities: z.array(z.string()),
  probedAt: z.string().datetime()
}).strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

export const CustomizationMode = z.enum(["restricted", "inherit-user-configuration"]);
export type CustomizationMode = z.infer<typeof CustomizationMode>;

export const AgentRole = z.enum([
  "WORKER",
  "AUDITOR",
  "PLANNER",
  "PRODUCT_CHALLENGER",
  "FINAL_VERIFIER"
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const SessionPurpose = z.enum([
  "PRODUCT",
  "PLANNING",
  "PLAN_AUDIT",
  "IMPLEMENTATION",
  "REVIEW",
  "FINAL_REVIEW",
  "HISTORICAL_CONTEXT"
]);
export type SessionPurpose = z.infer<typeof SessionPurpose>;

export const ExternalSessionCompatibility = z.object({
  schemaVersion: SchemaVersion,
  externalSessionIdHash: z.string(),
  provider: z.enum(["codex", "claude"]),
  requestedRole: AgentRole,
  requestedPurpose: SessionPurpose,
  compatible: z.boolean(),
  nativeSessionEligible: z.boolean(),
  contextBriefOnly: z.boolean(),
  checks: z.object({
    repository: z.boolean(),
    baseCommit: z.boolean(),
    branch: z.boolean(),
    objective: z.boolean(),
    taskContract: z.boolean(),
    role: z.boolean(),
    purpose: z.boolean(),
    restrictedConfiguration: z.boolean()
  }).strict(),
  reasons: z.array(z.string()),
  evaluatedAt: z.string().datetime()
}).strict();
export type ExternalSessionCompatibility = z.infer<typeof ExternalSessionCompatibility>;

export const AccessMode = z.enum(["read-only", "workspace-write"]);
export type AccessMode = z.infer<typeof AccessMode>;

export const RoleConfiguration = z.object({
  schemaVersion: SchemaVersion,
  mode: z.enum(["fixed", "both-capable", "alternate-each-iteration", "alternate-after-approval", "manual-routing"]),
  initialWorker: z.enum(["codex", "claude"]),
  initialAuditor: z.enum(["codex", "claude"]),
  capabilities: z.object({
    codex: z.object({ canWork: z.boolean(), canAudit: z.boolean(), canPlan: z.boolean(), canFinalVerify: z.boolean() }).strict(),
    claude: z.object({ canWork: z.boolean(), canAudit: z.boolean(), canPlan: z.boolean(), canFinalVerify: z.boolean() }).strict()
  }).strict(),
  switching: z.object({
    enabled: z.boolean(),
    trigger: z.enum(["manual", "each-audited-iteration", "audit-requested-changes", "auditor-approval"]),
    maxConsecutiveWorkerIterations: z.number().int().positive()
  }).strict(),
  finalVerification: z.object({
    provider: z.enum(["codex", "claude", "automatic"]),
    freshSessionRequired: z.literal(true),
    prohibitLatestWorker: z.literal(true)
  }).strict()
}).strict().superRefine((configuration, context) => {
  if (configuration.mode === "fixed" && configuration.initialWorker === configuration.initialAuditor) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Fixed Worker and Auditor providers must differ" });
  }
  if (!configuration.capabilities[configuration.initialWorker].canWork) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Initial Worker lacks Worker capability" });
  }
  if (!configuration.capabilities[configuration.initialAuditor].canAudit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Initial Auditor lacks Auditor capability" });
  }
});
export type RoleConfiguration = z.infer<typeof RoleConfiguration>;

export const RoleAssignment = z.object({
  schemaVersion: SchemaVersion,
  workItemId: z.string().min(1),
  stage: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  worker: z.enum(["codex", "claude"]),
  auditor: z.enum(["codex", "claude"]),
  workerSessionIdHash: z.string().optional(),
  auditorSessionIdHash: z.string().optional(),
  workerAccess: z.literal("workspace-write"),
  auditorAccess: z.literal("read-only"),
  previousAssignmentId: z.string().optional(),
  switchingReason: z.enum([
    "initial_configuration",
    "fixed_assignment",
    "scheduled_alternation",
    "audit_requested_changes",
    "user_override",
    "provider_unavailable"
  ]),
  createdAt: z.string().datetime()
}).strict().refine((assignment) => assignment.worker !== assignment.auditor, {
  message: "Worker and Auditor must differ for independent review"
});
export type RoleAssignment = z.infer<typeof RoleAssignment>;

export const TaskContract = z.object({
  schemaVersion: SchemaVersion,
  workItemId: z.string().min(1),
  revision: z.number().int().positive(),
  parentHash: z.string().nullable(),
  objective: z.string().min(1),
  userInstruction: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  prohibitedPaths: z.array(z.string().min(1)),
  validationCommands: z.array(z.object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().default(".")
  }).strict()),
  risks: z.array(z.string()),
  humanAuthorizations: z.array(z.string()),
  createdBy: z.literal("user"),
  createdAt: z.string().datetime()
}).strict();
export type TaskContract = z.infer<typeof TaskContract>;

export const ProductChallenge = z.object({
  schemaVersion: SchemaVersion,
  userProblem: z.string().min(1),
  expectedValue: z.string().min(1),
  existingBehavior: z.array(z.string()),
  smallestUsefulScope: z.string().min(1),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  nonGoals: z.array(z.string()),
  humanQuestions: z.array(z.string())
}).strict();
export type ProductChallenge = z.infer<typeof ProductChallenge>;

export const ImplementationPlan = z.object({
  schemaVersion: SchemaVersion,
  version: z.number().int().positive(),
  behavior: z.array(z.string()).min(1),
  approach: z.string().min(1),
  reusedComponents: z.array(z.string()),
  allowedPaths: z.array(z.string()).min(1),
  prohibitedPaths: z.array(z.string()),
  steps: z.array(z.object({ id: z.string(), description: z.string(), paths: z.array(z.string()), dependsOn: z.array(z.string()) }).strict()).min(1),
  tests: z.array(z.string()),
  validationCommands: z.array(z.object({ executable: z.string(), args: z.array(z.string()), cwd: z.string() }).strict()),
  risks: z.array(z.string()),
  rollback: z.string().min(1),
  humanAuthorizations: z.array(z.string())
}).strict();
export type ImplementationPlan = z.infer<typeof ImplementationPlan>;

export const PlanAudit = z.object({
  schemaVersion: SchemaVersion,
  decision: z.enum(["APPROVE", "REVISE", "BLOCK"]),
  summary: z.string(),
  feasibilityFindings: z.array(z.string()),
  assumptionFindings: z.array(z.string()),
  scopeFindings: z.array(z.string()),
  testFindings: z.array(z.string()),
  safetyFindings: z.array(z.string()),
  requiredRevisions: z.array(z.string())
}).strict();
export type PlanAudit = z.infer<typeof PlanAudit>;

export const ContextBrief = z.object({
  schemaVersion: SchemaVersion,
  objective: z.string(),
  userProblem: z.string(),
  decisions: z.array(z.string()),
  requirements: z.array(z.string()),
  rejectedApproaches: z.array(z.string()),
  technicalDiscoveries: z.array(z.string()),
  productDiscoveries: z.array(z.string()),
  relevantFiles: z.array(z.string()),
  completedWork: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  repository: z.object({
    rootHash: z.string(),
    branch: z.string(),
    baseCommit: z.string(),
    latestCommit: z.string()
  }).strict(),
  recommendedNextAction: z.string()
}).strict();
export type ContextBrief = z.infer<typeof ContextBrief>;

export const Finding = z.object({
  id: z.string().min(1),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  origin: z.enum(["INTRODUCED_BY_LATEST_CHANGE", "PREVIOUSLY_UNDETECTABLE", "PREEXISTING_OUT_OF_SCOPE", "OPTIONAL"]),
  title: z.string().min(1),
  evidence: z.string().min(1),
  blocking: z.boolean(),
  status: z.enum(["open", "resolved", "accepted-risk"])
}).strict();
export type Finding = z.infer<typeof Finding>;

export const ValidationResult = z.object({
  schemaVersion: SchemaVersion,
  id: z.string(),
  executableHash: z.string(),
  args: z.array(z.string()),
  cwdHash: z.string(),
  environmentDigest: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  outputHash: z.string(),
  logRef: z.string(),
  passed: z.boolean()
}).strict();
export type ValidationResult = z.infer<typeof ValidationResult>;

const HandoffIdentity = z.union([
  z.object({ provider: z.enum(["codex", "claude"]), role: AgentRole }).strict(),
  z.object({ provider: z.literal("orchestrator"), role: z.literal("ORCHESTRATOR") }).strict()
]);

export const HandoffPacket = z.object({
  schemaVersion: SchemaVersion,
  workItemId: z.string(),
  from: HandoffIdentity,
  to: HandoffIdentity,
  fromStage: z.string(),
  toStage: z.string(),
  iteration: z.number().int().nonnegative(),
  summary: z.string(),
  taskContractVersion: z.number().int().positive(),
  planVersion: z.number().int().positive(),
  decisions: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  changedFiles: z.array(z.string()),
  diffHash: z.string(),
  validationRefs: z.array(z.string()),
  findings: z.array(Finding),
  resolvedFindingIds: z.array(z.string()),
  unresolvedFindingIds: z.array(z.string()),
  assumptions: z.array(z.string()),
  blockers: z.array(z.string()),
  recommendedNextAction: z.string(),
  contextBriefRefs: z.array(z.string()),
  createdAt: z.string().datetime()
}).strict();
export type HandoffPacket = z.infer<typeof HandoffPacket>;

export const CoordinationEnvelope = z.object({
  schemaVersion: SchemaVersion,
  workItemId: z.string(),
  taskContractVersion: z.number().int().positive(),
  stage: z.string(),
  iteration: z.number().int().nonnegative(),
  repositoryHash: z.string(),
  baseCommit: z.string(),
  checkpointCommit: z.string(),
  provider: z.enum(["codex", "claude"]),
  role: AgentRole,
  purpose: SessionPurpose,
  access: AccessMode,
  otherProviderRole: AgentRole.optional(),
  authority: z.array(z.string()).min(4),
  approvedPaths: z.array(z.string()),
  prohibitedPaths: z.array(z.string()),
  commandPolicyDigest: z.string(),
  must: z.array(z.string()),
  mustNot: z.array(z.string()),
  outputSchema: z.string()
}).strict();
export type CoordinationEnvelope = z.infer<typeof CoordinationEnvelope>;

export const WorkerResult = z.object({
  schemaVersion: SchemaVersion,
  summary: z.string(),
  changedFiles: z.array(z.string()),
  testsRequested: z.array(z.string()),
  resolvedFindingIds: z.array(z.string()),
  assumptions: z.array(z.string()),
  blockers: z.array(z.string())
}).strict();
export type WorkerResult = z.infer<typeof WorkerResult>;

export const AuditResult = z.object({
  schemaVersion: SchemaVersion,
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK"]),
  summary: z.string(),
  findings: z.array(Finding)
}).strict();
export type AuditResult = z.infer<typeof AuditResult>;

export const FinalVerification = z.object({
  schemaVersion: SchemaVersion,
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK"]),
  summary: z.string(),
  acceptanceEvidence: z.array(z.object({ criterion: z.string(), passed: z.boolean(), evidenceRefs: z.array(z.string()) }).strict()),
  findings: z.array(Finding),
  validationRefs: z.array(z.string()),
  scopeVerified: z.boolean(),
  primaryCheckoutUntouched: z.boolean(),
  prohibitedExternalActionsAbsent: z.boolean(),
  pendingHumanActions: z.array(z.string())
}).strict();
export type FinalVerification = z.infer<typeof FinalVerification>;

export const GitCheckpoint = z.object({
  schemaVersion: SchemaVersion,
  id: z.string(),
  workItemId: z.string(),
  stage: z.string(),
  branch: z.string(),
  commit: z.string(),
  indexHash: z.string(),
  diffHash: z.string(),
  untrackedManifestHash: z.string(),
  createdAt: z.string().datetime()
}).strict();
export type GitCheckpoint = z.infer<typeof GitCheckpoint>;

export const CommandPolicyContract = z.object({
  schemaVersion: SchemaVersion,
  allowed: z.array(z.object({ executableHash: z.string(), args: z.array(z.string()), match: z.enum(["exact", "prefix"]) }).strict()),
  hardDenials: z.array(z.string()).min(1),
  projectDenials: z.array(z.string()),
  approvedPaths: z.array(z.string()).min(1),
  prohibitedPaths: z.array(z.string())
}).strict();
export type CommandPolicyContract = z.infer<typeof CommandPolicyContract>;

export const WorkItemStatus = z.enum(["ACTIVE", "PAUSED", "COMPLETED", "BLOCKED", "FAILED", "ABORTED"]);
export type WorkItemStatus = z.infer<typeof WorkItemStatus>;

export const WorkItemStage = z.enum([
  "PREFLIGHT",
  "CONTEXT_CAPTURE",
  "PRODUCT_CHALLENGE",
  "PLANNING",
  "PLAN_AUDIT",
  "IMPLEMENTATION",
  "VALIDATION",
  "REVIEW",
  "REWORK",
  "FINAL_VALIDATION",
  "FINAL_VERIFICATION",
  "COMPLETION_EVALUATION"
]);
export type WorkItemStage = z.infer<typeof WorkItemStage>;

export const WorkItem = z.object({
  schemaVersion: SchemaVersion,
  id: z.string(),
  title: z.string(),
  repositoryRootHash: z.string(),
  baseCommit: z.string(),
  branch: z.string(),
  taskContractRevision: z.number().int().positive(),
  currentStage: WorkItemStage,
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  status: WorkItemStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type WorkItem = z.infer<typeof WorkItem>;

export const FinalReport = z.object({
  schemaVersion: SchemaVersion,
  workItemId: z.string(),
  status: WorkItemStatus,
  taskContractRevision: z.number().int().positive(),
  planVersion: z.number().int().positive(),
  baseCommit: z.string(),
  finalCommit: z.string(),
  branch: z.string(),
  roleAssignments: z.array(RoleAssignment),
  sessionIdHashes: z.array(z.string()),
  stageTraceRefs: z.array(z.string()),
  changedFiles: z.array(z.string()),
  validationRefs: z.array(z.string()),
  findings: z.array(Finding),
  acceptanceEvidence: z.array(z.object({ criterion: z.string(), passed: z.boolean(), evidenceRefs: z.array(z.string()) }).strict()),
  primaryCheckoutUntouched: z.boolean(),
  prohibitedExternalActionsAbsent: z.boolean(),
  pendingHumanActions: z.array(z.string()),
  decision: z.enum(["COMPLETED", "BLOCKED", "FAILED", "ABORTED", "AWAITING_MAINTAINER_DECISION"])
}).strict();
export type FinalReport = z.infer<typeof FinalReport>;

export const UtilityRequest = z.object({
  schemaVersion: SchemaVersion,
  requestId: z.string().uuid(),
  correlationId: z.string().uuid(),
  idempotencyKey: z.string().min(8),
  method: z.enum(["health", "probe", "run_stub_workflow", "get_work_item", "pause", "resume", "intervene", "shutdown"]),
  payload: z.unknown()
}).strict();
export type UtilityRequest = z.infer<typeof UtilityRequest>;

export const UtilityResponse = z.object({
  schemaVersion: SchemaVersion,
  requestId: z.string().uuid(),
  correlationId: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional()
}).strict();
export type UtilityResponse = z.infer<typeof UtilityResponse>;

export function defaultRoleConfiguration(): RoleConfiguration {
  return RoleConfiguration.parse({
    schemaVersion: SCHEMA_VERSION,
    mode: "fixed",
    initialWorker: "codex",
    initialAuditor: "claude",
    capabilities: {
      codex: { canWork: true, canAudit: true, canPlan: true, canFinalVerify: true },
      claude: { canWork: true, canAudit: true, canPlan: true, canFinalVerify: true }
    },
    switching: { enabled: false, trigger: "manual", maxConsecutiveWorkerIterations: 1 },
    finalVerification: { provider: "automatic", freshSessionRequired: true, prohibitLatestWorker: true }
  });
}
