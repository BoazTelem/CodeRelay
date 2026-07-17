import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  AuditResult, HandoffPacket, ImplementationPlan, PlanAudit, RoleAssignment, SCHEMA_VERSION, TaskContract, WorkerResult,
  type Finding
} from "../contracts/schemas.js";
import { CodeRelayDatabase } from "../persistence/database.js";
import { RealProviderAdapter } from "../providers/real-adapter.js";
import { BrokerConfig } from "../mcp/config.js";
import { builtMcpServerLaunch } from "../mcp/launch.js";
import { buildSafeEnvironment } from "../security/environment.js";
import { sha256 } from "../security/redaction.js";
import { inspectRepository, assertRepositoryMayStart } from "../repository/preflight.js";
import { TrustedGit, captureGitSnapshot, createIsolatedWorktree, restoreIsolatedCheckpoint } from "../repository/git.js";
import { runAuthoritativeValidation } from "./validation.js";
import { STAGE_PROMPTS } from "./prompts.js";
import { assessReadOnlyToolIsolation } from "./session-safety.js";

export interface RealHandoffTask {
  objective: string;
  userInstruction: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  validationCommands: { executable: string; args: string[]; cwd: string }[];
}

export interface RealHandoffOptions {
  database: CodeRelayDatabase;
  repository: string;
  worktreesDirectory: string;
  artifactsDirectory: string;
  gitExecutable: string;
  executables: { codex: string; claude: string };
  worker: "codex" | "claude";
  workItemId?: string;
  task?: RealHandoffTask;
  deterministicFixture?: boolean;
  confirmedUnpushed?: boolean;
  maxIterations?: number;
}

function fixtureTask(worker: "codex" | "claude", auditor: "codex" | "claude"): RealHandoffTask {
  return {
    objective: `Prove a real ${worker} Worker to ${auditor} Auditor handoff`,
    userInstruction: `Create src/result.txt containing a line that starts with "implemented by ${worker}"`,
    acceptanceCriteria: ["Only src/result.txt changes", "Authoritative validation passes", `A fresh ${auditor} Auditor approves`],
    allowedPaths: ["src"],
    prohibitedPaths: [".git", "validate.mjs"],
    validationCommands: [{ executable: process.execPath, args: ["validate.mjs"], cwd: "." }]
  };
}

function pathPermitted(file: string, allowedPaths: readonly string[], prohibitedPaths: readonly string[]): boolean {
  const matches = (candidate: string): boolean => {
    const value = candidate.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return value === "." || file === value || file.startsWith(`${value}/`);
  };
  return allowedPaths.some(matches) && !prohibitedPaths.some(matches) && !file.split("/").some((part) => part.toLowerCase() === ".git");
}

export interface RealHandoffEvidence {
  schemaVersion: "1.0.0";
  workItemId: string;
  direction: string;
  status: "COMPLETED" | "BLOCKED" | "PAUSED";
  baseCommit: string;
  finalCommit: string;
  branch: string;
  iterations: number;
  workerSessionHashes: string[];
  auditorSessionHashes: string[];
  checkpoints: string[];
  validationHashes: string[];
  findings: Finding[];
  primaryCheckoutUntouched: boolean;
  brokerOnly: boolean;
  prohibitedExternalActions: "none";
}

function providerView<T extends { validationCommands: { executable: string; args: string[]; cwd: string }[] }>(value: T): T {
  return {
    ...value,
    validationCommands: value.validationCommands.map((command) => ({ ...command, executable: path.basename(command.executable) }))
  };
}

function changedPaths(status: string, untracked: readonly string[]): string[] {
  return [...new Set([
    ...status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/^.* -> /, "").replaceAll("\\", "/")),
    ...untracked.map((file) => file.replaceAll("\\", "/"))
  ])].sort();
}

export async function runRealHandoff(options: RealHandoffOptions): Promise<RealHandoffEvidence> {
  const auditor = options.worker === "codex" ? "claude" : "codex";
  const fixture = options.deterministicFixture ?? options.task === undefined;
  const task = options.task ?? fixtureTask(options.worker, auditor);
  const preflight = await inspectRepository(options.repository, options.gitExecutable);
  assertRepositoryMayStart(preflight, options.confirmedUnpushed ?? false);
  const workItemId = options.workItemId ?? (fixture ? `wi_m2_${randomUUID()}` : `wi_${randomUUID()}`);
  const branch = `coderelay/${workItemId}`;
  const worktree = path.join(options.worktreesDirectory, workItemId);
  await mkdir(options.worktreesDirectory, { recursive: true });
  await mkdir(options.artifactsDirectory, { recursive: true });
  const primaryGit = new TrustedGit({ executable: options.gitExecutable, repository: preflight.canonicalRoot });
  const primaryBefore = await captureGitSnapshot(primaryGit);
  await createIsolatedWorktree(primaryGit, worktree, branch, preflight.head);
  const git = new TrustedGit({ executable: options.gitExecutable, repository: worktree });
  const contract = TaskContract.parse({
    schemaVersion: SCHEMA_VERSION,
    workItemId,
    revision: 1,
    parentHash: null,
    objective: task.objective,
    userInstruction: task.userInstruction,
    acceptanceCriteria: task.acceptanceCriteria,
    allowedPaths: task.allowedPaths,
    prohibitedPaths: task.prohibitedPaths,
    validationCommands: task.validationCommands,
    risks: ["Real provider must remain confined to the broker"],
    humanAuthorizations: [],
    createdBy: "user",
    createdAt: new Date().toISOString()
  });
  const approvedPlan = ImplementationPlan.parse({
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    behavior: [task.userInstruction],
    approach: "Use only the Work-Item-scoped CodeRelay broker tools, then rely on orchestrator validation and a fresh independent audit.",
    reusedComponents: ["CodeRelay MCP broker", "authoritative validation runner", "trusted Git checkpoint service"],
    allowedPaths: contract.allowedPaths,
    prohibitedPaths: contract.prohibitedPaths,
    steps: [{
      id: fixture ? "m2-fixture-change" : "user-task-change",
      description: fixture ? "Create the single approved fixture file" : "Implement the user instruction within the approved paths",
      paths: contract.allowedPaths,
      dependsOn: []
    }],
    tests: contract.validationCommands.length > 0
      ? ["Orchestrator runs the configured validation commands and records complete ValidationResults"]
      : ["No deterministic validation command is configured; the fresh independent audit is the acceptance authority"],
    validationCommands: contract.validationCommands,
    risks: contract.risks,
    rollback: "Restore the isolated worktree to the previous trusted checkpoint; never mutate the primary checkout.",
    humanAuthorizations: []
  });
  const approvedPlanAudit = PlanAudit.parse({
    schemaVersion: SCHEMA_VERSION,
    decision: "APPROVE",
    summary: fixture
      ? "The deterministic Milestone 2 fixture plan is feasible, path-scoped, independently validated, and reversible."
      : "The user task plan is path-scoped, broker-confined, checkpointed, and reversible; the orchestrator remains the sole validation authority.",
    feasibilityFindings: [], assumptionFindings: [], scopeFindings: [], testFindings: [], safetyFindings: [], requiredRevisions: []
  });
  options.database.createWorkItem({
    id: workItemId, title: contract.objective, repositoryRootHash: preflight.rootHash,
    primaryRoot: preflight.canonicalRoot, worktreeRoot: worktree, baseCommit: preflight.head,
    branch, stage: "IMPLEMENTATION", status: "ACTIVE", contract
  });
  options.database.saveCheckpoint(workItemId, "IMPLEMENTATION", preflight.head, await captureGitSnapshot(git));

  const restrictedPath = [...new Set([
    path.dirname(options.executables.codex), path.dirname(options.executables.claude), path.dirname(options.gitExecutable), path.dirname(process.execPath),
    ...(process.platform === "win32" && process.env.SystemRoot ? [path.join(process.env.SystemRoot, "System32")] : [])
  ])];
  const safe = buildSafeEnvironment({ restrictedPath, tempDirectory: os.tmpdir(), homeDirectory: os.homedir() });
  const nonce = `${randomUUID()}-${randomUUID()}`;
  const brokerPath = path.join(await mkdtemp(path.join(os.tmpdir(), "coderelay-runtime-")), `${workItemId}.broker.json`);
  const broker = BrokerConfig.parse({
    schemaVersion: SCHEMA_VERSION, workItemId, capabilityNonceHash: sha256(nonce),
    expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(), root: worktree,
    approvedPaths: contract.allowedPaths, prohibitedPaths: contract.prohibitedPaths,
    commandRules: [], restrictedPath, tempDirectory: os.tmpdir(), homeDirectory: os.homedir()
  });
  await writeFile(brokerPath, `${JSON.stringify(broker)}\n`, "utf8");
  const redactedBroker = {
    ...broker,
    root: sha256(broker.root),
    restrictedPath: broker.restrictedPath.map((entry) => sha256(entry)),
    tempDirectory: broker.tempDirectory === undefined ? undefined : sha256(broker.tempDirectory),
    homeDirectory: broker.homeDirectory === undefined ? undefined : sha256(broker.homeDirectory)
  };
  await writeFile(path.join(options.artifactsDirectory, `${workItemId}.broker.json`), `${JSON.stringify(redactedBroker)}\n`, "utf8");
  const server = builtMcpServerLaunch();
  const processObserver = {
    started: (processRecord: { id: string; pid: number; executable: string; startedAt: string }) => options.database.recordProcess({
      id: processRecord.id, workItemId, pid: processRecord.pid, executableHash: sha256(processRecord.executable),
      processStartIdentity: `${processRecord.pid}:${processRecord.startedAt}`, capabilityNonceHash: broker.capabilityNonceHash
    }),
    stopped: (processRecord: { id: string; state: "exited" | "cancelled" | "terminated" }) => options.database.stopRecordedProcess(processRecord.id, processRecord.state)
  };
  const workerAdapter = new RealProviderAdapter({
    provider: options.worker,
    executable: options.executables[options.worker],
    environment: safe.values,
    artifactDirectory: path.join(options.artifactsDirectory, workItemId, "worker"),
    mcpServer: { command: server.command, args: [...server.args, "--config", brokerPath, "--nonce", nonce] },
    processObserver
  });
  const auditorAdapter = new RealProviderAdapter({
    provider: auditor,
    executable: options.executables[auditor],
    environment: safe.values,
    artifactDirectory: path.join(options.artifactsDirectory, workItemId, "auditor"),
    processObserver
  });
  for (const adapter of [workerAdapter, auditorAdapter]) {
    const authentication = await adapter.authenticate();
    if (authentication.state !== "SUBSCRIPTION_VERIFIED") {
      options.database.transition(workItemId, "IMPLEMENTATION", "PAUSED", "provider.authentication_failed", { provider: adapter.provider, state: authentication.state });
      return evidence("PAUSED", preflight.head, 0, [], [], [], [], [], false);
    }
  }

  let iteration = 0;
  let checkpoint = preflight.head;
  const checkpoints: string[] = [checkpoint];
  const workerSessions: string[] = [];
  const auditorSessions: string[] = [];
  const validationHashes: string[] = [];
  let findings: Finding[] = [];
  let brokerOnly = true;
  const maxIterations = options.maxIterations ?? 3;
  while (iteration < maxIterations) {
    iteration += 1;
    const leaseOwner = `worker_${randomUUID()}`;
    options.database.acquireWorkerLease(workItemId, leaseOwner, iteration === 1 ? "IMPLEMENTATION" : "REWORK", 10 * 60_000);
    persistAssignment(iteration === 1 ? "IMPLEMENTATION" : "REWORK", iteration);
    const worker = await workerAdapter.runTurn({
      workItemId,
      purpose: "IMPLEMENTATION",
      prompt: `${iteration === 1 ? STAGE_PROMPTS.IMPLEMENTATION : STAGE_PROMPTS.REWORK}\n\nTaskContract:\n${JSON.stringify(providerView(contract))}\n\nApprovedPlan:\n${JSON.stringify(providerView(approvedPlan))}\n\nOpen findings:\n${JSON.stringify(findings)}\n\nDo not run validation yourself. The orchestrator is the only validation authority and will attach complete results to the Auditor handoff.`,
      outputSchema: WorkerResult,
      schemaName: "WorkerResult",
      access: "workspace-write",
      customizationMode: "restricted",
      cwd: worktree,
      session: iteration === 1 ? { mode: "new" } : { mode: "resume-id", value: workerSessions.at(-1)! },
      timeoutMs: 15 * 60_000
    });
    // Keep raw IDs only in memory for compatible implementation resumption; evidence stores hashes.
    const rawWorkerSession = worker.nativeSessionId;
    workerSessions.push(rawWorkerSession);
    brokerOnly &&= worker.eventSummary.toolNames.length > 0
      && worker.eventSummary.toolNames.every((name) => /coderelay/i.test(name))
      && !worker.eventSummary.toolNames.some((name) => /Bash|shell|unified_exec|(?:^|\/)Edit$|(?:^|\/)Write$/i.test(name));
    const postWorker = await captureGitSnapshot(git);
    const changed = changedPaths(postWorker.status, postWorker.untrackedFiles);
    const scopeViolated = fixture
      ? changed.some((file) => file !== "src/result.txt")
      : changed.some((file) => !pathPermitted(file, contract.allowedPaths, contract.prohibitedPaths));
    if (postWorker.head !== checkpoint || postWorker.branch !== branch || postWorker.indexDiff !== "" || scopeViolated || !brokerOnly) {
      await restoreIsolatedCheckpoint(git, preflight.canonicalRoot, worktree, checkpoint, branch);
      options.database.releaseWorkerLease(workItemId, leaseOwner);
      options.database.transition(workItemId, "IMPLEMENTATION", "BLOCKED", "scope.violation", { iteration, changedPathHashes: changed.map(sha256), brokerOnly });
      return evidence("BLOCKED", checkpoint, iteration, workerSessions, auditorSessions, checkpoints, validationHashes, findings, brokerOnly);
    }
    if (fixture) {
      const implemented = await readFile(path.join(worktree, "src", "result.txt"), "utf8").catch(() => "");
      if (!implemented.startsWith(`implemented by ${options.worker}`)) {
        options.database.releaseWorkerLease(workItemId, leaseOwner);
        findings = [{
          id: `acceptance_${iteration}`, priority: "P1", origin: "INTRODUCED_BY_LATEST_CHANGE",
          title: "Fixture content does not satisfy the deterministic acceptance criterion",
          evidence: sha256(implemented), blocking: true, status: "open"
        }];
        options.database.transition(workItemId, "REWORK", "ACTIVE", "acceptance.failed", { iteration, evidenceHash: sha256(implemented) });
        continue;
      }
    } else if (changed.length === 0) {
      options.database.releaseWorkerLease(workItemId, leaseOwner);
      findings = [{
        id: `acceptance_${iteration}`, priority: "P1", origin: "INTRODUCED_BY_LATEST_CHANGE",
        title: "Worker turn produced no changes in the isolated worktree",
        evidence: `iteration:${iteration}`, blocking: true, status: "open"
      }];
      options.database.transition(workItemId, "REWORK", "ACTIVE", "acceptance.failed", { iteration, evidenceHash: sha256("no-changes") });
      continue;
    }
    persistAssignment("VALIDATION", iteration);
    const validations = await runAuthoritativeValidation(contract, worktree);
    validationHashes.push(...validations.map((validation) => validation.outputHash));
    if (!validations.every((validation) => validation.passed)) {
      options.database.releaseWorkerLease(workItemId, leaseOwner);
      findings = [{ id: `validation_${iteration}`, priority: "P1", origin: "INTRODUCED_BY_LATEST_CHANGE", title: "Authoritative validation failed", evidence: validations.map((value) => value.outputHash).join(","), blocking: true, status: "open" }];
      options.database.transition(workItemId, "REWORK", "ACTIVE", "validation.failed", { iteration, validationHashes });
      continue;
    }
    await git.run(["add", "--all"]);
    await git.run(["commit", "-m", `CodeRelay checkpoint ${iteration}: ${task.objective.slice(0, 72)}`]);
    checkpoint = (await git.run(["rev-parse", "HEAD"])).trim();
    checkpoints.push(checkpoint);
    options.database.saveCheckpoint(workItemId, "VALIDATION", checkpoint, await captureGitSnapshot(git));
    options.database.releaseWorkerLease(workItemId, leaseOwner);

    const diff = await git.run(["diff", `${preflight.head}..${checkpoint}`, "--binary"]);
    const packet = HandoffPacket.parse({
      schemaVersion: SCHEMA_VERSION, workItemId,
      from: { provider: options.worker, role: "WORKER" }, to: { provider: auditor, role: "AUDITOR" },
      fromStage: iteration === 1 ? "IMPLEMENTATION" : "REWORK", toStage: "REVIEW", iteration,
      summary: worker.output.summary, taskContractVersion: 1, planVersion: 1,
      decisions: [fixture ? "Deterministic fixture plan approved" : "User task plan approved", "Orchestrator is the sole validation authority"],
      evidenceRefs: validationHashes, changedFiles: changed, diffHash: sha256(diff),
      validationRefs: validationHashes, findings, resolvedFindingIds: worker.output.resolvedFindingIds,
      unresolvedFindingIds: findings.filter((finding) => finding.status === "open").map((finding) => finding.id),
      assumptions: worker.output.assumptions, blockers: worker.output.blockers,
      recommendedNextAction: "Perform fresh independent review", contextBriefRefs: [fixture ? "m2:fixture" : "user:task"], createdAt: new Date().toISOString()
    });
    options.database.saveHandoff(packet);
    options.database.transition(workItemId, "REVIEW", "ACTIVE", "handoff.created", { iteration, diffHash: packet.diffHash });
    persistAssignment("REVIEW", iteration);
    const fileManifest = (await git.run(["ls-files"])).split(/\r?\n/).filter(Boolean).sort();
    const repositoryRules = {
      approvedInstructionFiles: [],
      untrustedInstructionFiles: [],
      allowedPaths: contract.allowedPaths,
      prohibitedPaths: contract.prohibitedPaths,
      primaryCheckoutMustRemainUntouched: true
    };
    const gitEvidence = {
      baseCommit: preflight.head,
      checkpointCommit: checkpoint,
      branch,
      indexClean: (await git.run(["diff", "--cached", "--quiet"]).then(() => true, () => false)),
      changedPaths: changed
    };
    const audit = await auditorAdapter.runTurn({
      workItemId,
      purpose: "REVIEW",
      prompt: `${STAGE_PROMPTS.REVIEW}\n\nTaskContract:\n${JSON.stringify(providerView(contract))}\n\nApprovedPlan:\n${JSON.stringify(providerView(approvedPlan))}\n\nPlanAudit:\n${JSON.stringify(approvedPlanAudit)}\n\nRepositoryRules:\n${JSON.stringify(repositoryRules)}\n\nFileManifest:\n${JSON.stringify(fileManifest)}\n\nGitEvidence:\n${JSON.stringify(gitEvidence)}\n\nOrchestratorValidationResults (sole validation authority):\n${JSON.stringify(validations)}\n\nHandoff:\n${JSON.stringify(packet)}\n\nFull diff:\n${diff}`,
      outputSchema: AuditResult,
      schemaName: "AuditResult",
      access: "read-only",
      customizationMode: "restricted",
      cwd: worktree,
      session: { mode: "new" },
      timeoutMs: 15 * 60_000
    });
    auditorSessions.push(audit.nativeSessionId);
    const toolIsolation = assessReadOnlyToolIsolation(audit.eventSummary);
    if (toolIsolation.deniedToolAttempts.length > 0) {
      options.database.appendEvent(workItemId, "audit.tool_attempts_denied", {
        iteration,
        toolNames: toolIsolation.deniedToolAttempts,
        toolOutcomes: audit.eventSummary.toolOutcomes
      });
    }
    if (!audit.freshSession || audit.sessionIdHash === worker.sessionIdHash || !toolIsolation.passed) {
      options.database.transition(workItemId, "REVIEW", "BLOCKED", "session.isolation_failed", {
        iteration,
        freshSession: audit.freshSession,
        sessionCollision: audit.sessionIdHash === worker.sessionIdHash,
        toolNames: audit.eventSummary.toolNames,
        availableToolNames: audit.eventSummary.availableToolNames,
        mcpServerStatuses: audit.eventSummary.mcpServerStatuses,
        toolOutcomes: audit.eventSummary.toolOutcomes,
        executableToolsAvailable: toolIsolation.executableToolsAvailable,
        undeniedToolAttempts: toolIsolation.undeniedToolAttempts
      });
      return evidence("BLOCKED", checkpoint, iteration, workerSessions, auditorSessions, checkpoints, validationHashes, findings, brokerOnly);
    }
    findings = audit.output.findings;
    options.database.appendEvent(workItemId, "audit.completed", { iteration, decision: audit.output.decision, sessionIdHash: audit.sessionIdHash, findings });
    if (audit.output.decision === "APPROVE") {
      const finalValidation = await runAuthoritativeValidation(contract, worktree);
      validationHashes.push(...finalValidation.map((validation) => validation.outputHash));
      const primaryAfter = await captureGitSnapshot(primaryGit);
      const primaryUntouched = primaryBefore.fingerprint === primaryAfter.fingerprint;
      const completed = finalValidation.every((validation) => validation.passed) && primaryUntouched;
      options.database.transition(workItemId, "COMPLETION_EVALUATION", completed ? "COMPLETED" : "BLOCKED", completed ? "work_item.completed" : "completion.blocked", { primaryUntouched, validationHashes });
      return evidence(completed ? "COMPLETED" : "BLOCKED", checkpoint, iteration, workerSessions, auditorSessions, checkpoints, validationHashes, findings, brokerOnly, primaryUntouched);
    }
    if (audit.output.decision === "BLOCK") {
      options.database.transition(workItemId, "REVIEW", "BLOCKED", "audit.blocked", { iteration, findings });
      return evidence("BLOCKED", checkpoint, iteration, workerSessions, auditorSessions, checkpoints, validationHashes, findings, brokerOnly);
    }
    options.database.transition(workItemId, "REWORK", "ACTIVE", "audit.requested_changes", { iteration, findings });
  }
  options.database.transition(workItemId, "REWORK", "BLOCKED", "iteration_limit.exhausted", { iterations: iteration });
  return evidence("BLOCKED", checkpoint, iteration, workerSessions, auditorSessions, checkpoints, validationHashes, findings, brokerOnly);

  function persistAssignment(stage: string, assignmentIteration: number): void {
    options.database.saveRoleAssignment(RoleAssignment.parse({
      schemaVersion: SCHEMA_VERSION, workItemId, stage, iteration: assignmentIteration,
      worker: options.worker, auditor, workerAccess: "workspace-write", auditorAccess: "read-only",
      switchingReason: assignmentIteration === 1 && stage === "IMPLEMENTATION" ? "initial_configuration" : "fixed_assignment",
      createdAt: new Date().toISOString()
    }));
  }

  function evidence(
    status: RealHandoffEvidence["status"], finalCommit: string, iterations: number,
    rawWorkerSessions: string[], rawAuditorSessions: string[], checkpointValues: string[], validationValues: string[], findingValues: Finding[],
    brokerOnlyValue: boolean, primaryCheckoutUntouched = true
  ): RealHandoffEvidence {
    return {
      schemaVersion: SCHEMA_VERSION, workItemId, direction: `${options.worker}-to-${auditor}`, status,
      baseCommit: preflight.head, finalCommit, branch, iterations,
      workerSessionHashes: rawWorkerSessions.map(sha256), auditorSessionHashes: rawAuditorSessions.map(sha256),
      checkpoints: checkpointValues, validationHashes: validationValues, findings: findingValues,
      primaryCheckoutUntouched, brokerOnly: brokerOnlyValue, prohibitedExternalActions: "none"
    };
  }
}
