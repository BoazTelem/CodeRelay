import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  AuditResult, ContextBrief, HandoffPacket, RoleAssignment, SCHEMA_VERSION, TaskContract, WorkerResult,
  defaultRoleConfiguration, type Finding
} from "../contracts/schemas.js";
import { CodeRelayDatabase } from "../persistence/database.js";
import { inspectRepository, assertRepositoryMayStart } from "../repository/preflight.js";
import { TrustedGit, captureGitSnapshot, createIsolatedWorktree, restoreIsolatedCheckpoint } from "../repository/git.js";
import { PathPolicy, applyStructuredPatch } from "../security/path-policy.js";
import { CommandBroker, CommandPolicy } from "../security/command-policy.js";
import { buildSafeEnvironment } from "../security/environment.js";
import { sha256 } from "../security/redaction.js";
import { StubProviderAdapter, ProviderUnavailableError, type StubScenario } from "../providers/stub-adapter.js";
import { runAuthoritativeValidation } from "./validation.js";
import { STAGE_PROMPTS } from "./prompts.js";
import { runCaptured } from "../platform/services.js";

export interface StubWorkflowOptions {
  database: CodeRelayDatabase;
  repository: string;
  gitExecutable: string;
  worktreesDirectory: string;
  worker: "codex" | "claude";
  workerScenarios?: StubScenario[];
  auditorScenarios?: StubScenario[];
}

export interface StubWorkflowReport {
  schemaVersion: "1.0.0";
  workItemId: string;
  status: "COMPLETED" | "PAUSED" | "BLOCKED";
  branch: string;
  finalCommit: string;
  worker: "codex" | "claude";
  auditor: "codex" | "claude";
  iterations: number;
  schemaCorrectionUsed: boolean;
  validationPassed: boolean;
  findings: Finding[];
  primaryCheckoutUntouched: boolean;
  prohibitedExternalActions: "none";
  gate: "MILESTONE_1_STUB_ONLY";
}

function providerBase(provider: "stub-codex" | "stub-claude"): "codex" | "claude" {
  return provider === "stub-codex" ? "codex" : "claude";
}

function changedPaths(snapshot: Awaited<ReturnType<typeof captureGitSnapshot>>): string[] {
  const statusPaths = snapshot.status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/^.* -> /, ""));
  return [...new Set([...statusPaths, ...snapshot.untrackedFiles])].sort();
}

function isApprovedPath(file: string, approved: readonly string[], prohibited: readonly string[]): boolean {
  const normalized = file.replaceAll("\\", "/");
  const prefix = (candidate: string) => {
    const value = candidate.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return value === "." || normalized === value || normalized.startsWith(`${value}/`);
  };
  return approved.some(prefix) && !prohibited.some(prefix) && !normalized.split("/").some((part) => part.toLowerCase() === ".git");
}

export async function runStubWorkflow(options: StubWorkflowOptions): Promise<StubWorkflowReport> {
  const preflight = await inspectRepository(options.repository, options.gitExecutable);
  assertRepositoryMayStart(preflight);
  const workItemId = `wi_${randomUUID()}`;
  const branch = `coderelay/${workItemId}`;
  const worktree = path.join(options.worktreesDirectory, workItemId);
  await mkdir(options.worktreesDirectory, { recursive: true });
  const primaryGit = new TrustedGit({ executable: options.gitExecutable, repository: preflight.canonicalRoot });
  const primaryBefore = await captureGitSnapshot(primaryGit);
  await createIsolatedWorktree(primaryGit, worktree, branch, preflight.head);
  const git = new TrustedGit({ executable: options.gitExecutable, repository: worktree });
  const initial = await captureGitSnapshot(git);
  const contract = TaskContract.parse({
    schemaVersion: SCHEMA_VERSION,
    workItemId,
    revision: 1,
    parentHash: null,
    objective: "Implement the isolated fixture change and pass deterministic validation",
    userInstruction: "Create src/result.txt through the restricted tool layer",
    acceptanceCriteria: ["src/result.txt starts with implemented", "Authoritative validation passes", "A fresh independent Auditor approves"],
    allowedPaths: ["src"],
    prohibitedPaths: [".git", "validate.mjs"],
    validationCommands: [{ executable: process.execPath, args: ["validate.mjs"], cwd: "." }],
    risks: ["Stub output must not bypass path or command enforcement"],
    humanAuthorizations: [],
    createdBy: "user",
    createdAt: new Date().toISOString()
  });
  options.database.createWorkItem({
    id: workItemId,
    title: "Milestone 1 stub handoff",
    repositoryRootHash: preflight.rootHash,
    primaryRoot: preflight.canonicalRoot,
    worktreeRoot: worktree,
    baseCommit: preflight.head,
    branch,
    stage: "IMPLEMENTATION",
    status: "ACTIVE",
    contract
  });
  options.database.saveCheckpoint(workItemId, "IMPLEMENTATION", preflight.head, initial);
  const contextBrief = ContextBrief.parse({
    schemaVersion: SCHEMA_VERSION,
    objective: contract.objective,
    userProblem: "Prove autonomous handoff without bypassing CodeRelay policy",
    decisions: ["Use only stub providers and an isolated fixture worktree"],
    requirements: contract.acceptanceCriteria,
    rejectedApproaches: ["Direct provider shell or primary-checkout writes"],
    technicalDiscoveries: [],
    productDiscoveries: [],
    relevantFiles: ["src/result.txt", "validate.mjs"],
    completedWork: [],
    openQuestions: [],
    risks: contract.risks,
    repository: { rootHash: preflight.rootHash, branch, baseCommit: preflight.head, latestCommit: preflight.head },
    recommendedNextAction: "Run the assigned Worker through restricted tools"
  });
  options.database.appendEvent(workItemId, "context_brief.captured", { source: "stub-fixture", brief: contextBrief });

  const auditor = options.worker === "codex" ? "claude" : "codex";
  const configuration = defaultRoleConfiguration();
  configuration.initialWorker = options.worker;
  configuration.initialAuditor = auditor;
  const assignment = RoleAssignment.parse({
    schemaVersion: SCHEMA_VERSION,
    workItemId,
    stage: "IMPLEMENTATION",
    iteration: 1,
    worker: options.worker,
    auditor,
    workerAccess: "workspace-write",
    auditorAccess: "read-only",
    switchingReason: "initial_configuration",
    createdAt: new Date().toISOString()
  });
  options.database.saveRoleAssignment(assignment);
  options.database.appendEvent(workItemId, "role_configuration.applied", configuration);

  const paths = new PathPolicy({ root: worktree, approvedPaths: contract.allowedPaths, prohibitedPaths: contract.prohibitedPaths });
  await paths.initialize();
  const safe = buildSafeEnvironment({
    restrictedPath: [...new Set([path.dirname(process.execPath), path.dirname(options.gitExecutable), ...(process.platform === "win32" && process.env.SystemRoot ? [path.join(process.env.SystemRoot, "System32")] : [])])],
    tempDirectory: os.tmpdir(),
    homeDirectory: worktree
  });
  const commandRules = contract.validationCommands.map((command) => ({ executable: command.executable, args: command.args, match: "exact" as const }));
  const broker = new CommandBroker(new CommandPolicy(commandRules), new PathPolicy({ root: worktree, approvedPaths: ["."] }), safe);
  const toolHandler = async (tool: string, args: unknown): Promise<unknown> => {
    if (tool === "apply_patch") {
      const value = args as { edits: Array<{ path: string; content: string | null; expectedSha256?: string }> };
      return await applyStructuredPatch(paths, value.edits.map((edit) => ({ path: edit.path, content: edit.content, ...(edit.expectedSha256 ? { expectedSha256: edit.expectedSha256 } : {}) })));
    }
    if (tool === "run_command") return await broker.run(args as Parameters<CommandBroker["run"]>[0]);
    throw new Error(`TOOL_NOT_ALLOWED: ${tool}`);
  };
  const processObserver = {
    started: (processRecord: { id: string; pid: number; executable: string; startedAt: string }) => options.database.recordProcess({
      id: processRecord.id, workItemId, pid: processRecord.pid, executableHash: sha256(processRecord.executable),
      processStartIdentity: `${processRecord.pid}:${processRecord.startedAt}`, capabilityNonceHash: sha256(workItemId)
    }),
    stopped: (processRecord: { id: string; state: "exited" | "cancelled" | "terminated" }) => options.database.stopRecordedProcess(processRecord.id, processRecord.state)
  };
  const workerAdapter = new StubProviderAdapter(`stub-${options.worker}` as "stub-codex" | "stub-claude", [...(options.workerScenarios ?? ["worker-success"])], toolHandler, processObserver);
  const auditorAdapter = new StubProviderAdapter(`stub-${auditor}` as "stub-codex" | "stub-claude", [...(options.auditorScenarios ?? ["auditor-approve"])], async () => { throw new Error("AUDITOR_TOOL_CALL_FORBIDDEN"); }, processObserver);

  let iteration = 0;
  let checkpoint = preflight.head;
  let schemaCorrectionUsed = false;
  let allFindings: Finding[] = [];
  let openFindings: Finding[] = [];
  let lastValidationPassed = false;
  let auditDecision: "APPROVE" | "REQUEST_CHANGES" | "BLOCK" = "REQUEST_CHANGES";
  while (iteration < 5 && auditDecision === "REQUEST_CHANGES") {
    iteration += 1;
    persistAssignment(iteration === 1 ? "IMPLEMENTATION" : "REWORK", iteration);
    const leaseOwner = `worker_${randomUUID()}`;
    options.database.acquireWorkerLease(workItemId, leaseOwner, iteration === 1 ? "IMPLEMENTATION" : "REWORK");
    let workerResult;
    let violationAttempts = 0;
    while (true) {
      const before = await captureGitSnapshot(git);
      try {
        workerResult = await workerAdapter.runTurn({
          workItemId,
          purpose: "IMPLEMENTATION",
          prompt: iteration === 1 ? STAGE_PROMPTS.IMPLEMENTATION : STAGE_PROMPTS.REWORK,
          outputSchema: WorkerResult,
          schemaName: "WorkerResult@1.0.0",
          access: "workspace-write",
          customizationMode: "restricted",
          cwd: worktree,
          session: { mode: "new" },
          timeoutMs: 10_000
        });
        schemaCorrectionUsed ||= workerResult.schemaCorrectionUsed;
        if (workerResult.output.resolvedFindingIds.length) {
          const resolved = new Set(workerResult.output.resolvedFindingIds);
          allFindings = allFindings.map((finding) => resolved.has(finding.id) ? { ...finding, status: "resolved", blocking: false } : finding);
          openFindings = openFindings.filter((finding) => !resolved.has(finding.id));
        }
        const after = await captureGitSnapshot(git);
        const pathsChanged = changedPaths(after);
        if (after.head !== before.head || after.branch !== before.branch || after.indexDiff !== before.indexDiff || pathsChanged.some((file) => !isApprovedPath(file, contract.allowedPaths, contract.prohibitedPaths))) {
          throw new Error("SCOPE_VIOLATION: unexpected Git state or path mutation");
        }
        options.database.appendEvent(workItemId, "worker.turn_completed", { iteration, sessionIdHash: workerResult.sessionIdHash, diffHash: sha256(after.workingDiff), changedFiles: pathsChanged });
        break;
      } catch (error) {
        if (error instanceof ProviderUnavailableError) {
          options.database.releaseWorkerLease(workItemId, leaseOwner);
          options.database.transition(workItemId, iteration === 1 ? "IMPLEMENTATION" : "REWORK", "PAUSED", "provider.unavailable", { provider: options.worker, error: error.message });
          return report("PAUSED", checkpoint);
        }
        violationAttempts += 1;
        await restoreIsolatedCheckpoint(git, preflight.canonicalRoot, worktree, checkpoint, branch);
        options.database.appendEvent(workItemId, "policy.violation_rollback", { iteration, violationAttempts, error: error instanceof Error ? error.message : String(error), checkpoint });
        if (violationAttempts >= 2) {
          options.database.releaseWorkerLease(workItemId, leaseOwner);
          options.database.transition(workItemId, iteration === 1 ? "IMPLEMENTATION" : "REWORK", "BLOCKED", "policy.repeated_violation", { iteration });
          return report("BLOCKED", checkpoint);
        }
      }
    }

    persistAssignment("VALIDATION", iteration);
    const validations = await runAuthoritativeValidation(contract, worktree);
    lastValidationPassed = validations.every((validation) => validation.passed);
    options.database.appendEvent(workItemId, "validation.completed", { iteration, results: validations });
    if (!lastValidationPassed) {
      options.database.releaseWorkerLease(workItemId, leaseOwner);
      options.database.transition(workItemId, "REWORK", "BLOCKED", "validation.failed", { iteration });
      return report("BLOCKED", checkpoint);
    }
    await git.run(["add", "--all"]);
    await git.run(["commit", "-m", `CodeRelay checkpoint ${iteration}`]);
    checkpoint = (await git.run(["rev-parse", "HEAD"])).trim();
    const snapshot = await captureGitSnapshot(git);
    options.database.saveCheckpoint(workItemId, "VALIDATION", checkpoint, snapshot);
    options.database.releaseWorkerLease(workItemId, leaseOwner);

    const packet = HandoffPacket.parse({
      schemaVersion: SCHEMA_VERSION,
      workItemId,
      from: { provider: options.worker, role: "WORKER" },
      to: { provider: auditor, role: "AUDITOR" },
      fromStage: iteration === 1 ? "IMPLEMENTATION" : "REWORK",
      toStage: "REVIEW",
      iteration,
      summary: workerResult!.output.summary,
      taskContractVersion: contract.revision,
      planVersion: 1,
      decisions: [],
      evidenceRefs: validations.map((validation) => validation.id),
      changedFiles: workerResult!.output.changedFiles,
      diffHash: sha256(await git.run(["diff", `${preflight.head}..${checkpoint}`, "--binary"])),
      validationRefs: validations.map((validation) => validation.id),
      findings: openFindings,
      resolvedFindingIds: workerResult!.output.resolvedFindingIds,
      unresolvedFindingIds: openFindings.map((finding) => finding.id),
      assumptions: workerResult!.output.assumptions,
      blockers: workerResult!.output.blockers,
      recommendedNextAction: "Perform a fresh independent review",
      contextBriefRefs: ["context:stub"],
      createdAt: new Date().toISOString()
    });
    options.database.saveHandoff(packet);
    options.database.transition(workItemId, "REVIEW", "ACTIVE", "handoff.created", { iteration, packet });
    persistAssignment("REVIEW", iteration);
    const audit = await auditorAdapter.runTurn({
      workItemId,
      purpose: "REVIEW",
      prompt: `${STAGE_PROMPTS.REVIEW}\n\nHandoff:\n${JSON.stringify(packet)}`,
      outputSchema: AuditResult,
      schemaName: "AuditResult@1.0.0",
      access: "read-only",
      customizationMode: "restricted",
      cwd: worktree,
      session: { mode: "new" },
      timeoutMs: 10_000
    });
    if (!audit.freshSession || audit.sessionIdHash === workerResult!.sessionIdHash) throw new Error("SESSION_ISOLATION_VIOLATION");
    auditDecision = audit.output.decision;
    openFindings = audit.output.findings;
    const byId = new Map(allFindings.map((finding) => [finding.id, finding]));
    for (const finding of openFindings) byId.set(finding.id, finding);
    allFindings = [...byId.values()];
    options.database.appendEvent(workItemId, "audit.completed", { iteration, provider: providerBase(audit.provider as "stub-codex" | "stub-claude"), sessionIdHash: audit.sessionIdHash, fresh: audit.freshSession, decision: auditDecision, findings: openFindings });
    if (auditDecision === "BLOCK") {
      options.database.transition(workItemId, "REVIEW", "BLOCKED", "audit.blocked", { iteration, findings: openFindings });
      return report("BLOCKED", checkpoint);
    }
    if (auditDecision === "REQUEST_CHANGES") options.database.transition(workItemId, "REWORK", "ACTIVE", "audit.requested_changes", { iteration, findings: openFindings });
  }

  if (auditDecision !== "APPROVE") {
    options.database.transition(workItemId, "REVIEW", "BLOCKED", "iteration_limit.exhausted", { iteration });
    return report("BLOCKED", checkpoint);
  }
  persistAssignment("FINAL_VALIDATION", iteration);
  const finalValidation = await runAuthoritativeValidation(contract, worktree);
  lastValidationPassed = finalValidation.every((validation) => validation.passed);
  const primaryAfter = await captureGitSnapshot(primaryGit);
  const primaryCheckoutUntouched = primaryBefore.fingerprint === primaryAfter.fingerprint;
  const completed = lastValidationPassed && primaryCheckoutUntouched;
  options.database.transition(workItemId, "COMPLETION_EVALUATION", completed ? "COMPLETED" : "BLOCKED", completed ? "work_item.completed" : "completion.blocked", {
    iteration, finalValidation, primaryCheckoutUntouched, prohibitedExternalActions: "none"
  });
  return report(completed ? "COMPLETED" : "BLOCKED", checkpoint, primaryCheckoutUntouched);

  function report(status: "COMPLETED" | "PAUSED" | "BLOCKED", finalCommit: string, primaryCheckoutUntouched = true): StubWorkflowReport {
    return {
      schemaVersion: SCHEMA_VERSION,
      workItemId,
      status,
      branch,
      finalCommit,
      worker: options.worker,
      auditor,
      iterations: iteration,
      schemaCorrectionUsed,
      validationPassed: lastValidationPassed,
      findings: allFindings,
      primaryCheckoutUntouched,
      prohibitedExternalActions: "none",
      gate: "MILESTONE_1_STUB_ONLY"
    };
  }

  function persistAssignment(stage: string, assignmentIteration: number): void {
    options.database.saveRoleAssignment(RoleAssignment.parse({
      schemaVersion: SCHEMA_VERSION,
      workItemId,
      stage,
      iteration: assignmentIteration,
      worker: options.worker,
      auditor,
      workerAccess: "workspace-write",
      auditorAccess: "read-only",
      switchingReason: "fixed_assignment",
      createdAt: new Date().toISOString()
    }));
  }
}

export async function createStubFixture(gitExecutable: string, parent?: string): Promise<{ root: string; worktrees: string }> {
  const base = await mkdtemp(path.join(parent ?? os.tmpdir(), "coderelay-fixture-"));
  const root = path.join(base, "repository");
  const worktrees = path.join(base, "worktrees");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "README.txt"), "CodeRelay Milestone 1 fixture\n", "utf8");
  await writeFile(path.join(root, "validate.mjs"), `import { readFile } from "node:fs/promises";\nconst value = await readFile(new URL("./src/result.txt", import.meta.url), "utf8");\nif (!value.startsWith("implemented")) {\n  console.error("VALIDATION FAIL: src/result.txt does not start with \\"implemented\\"");\n  process.exit(1);\n}\nconsole.log("VALIDATION PASS: src/result.txt starts with \\"implemented\\"");\n`, "utf8");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "CodeRelay Orchestrator"],
    ["config", "user.email", "coderelay@invalid.example"],
    ["add", "--all"],
    ["commit", "-m", "Fixture base"]
  ]) {
    const result = await runCaptured(gitExecutable, ["-C", root, ...args], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`Fixture Git setup failed: ${result.stderr}`);
  }
  return { root, worktrees };
}
