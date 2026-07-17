#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HandoffPacket, UtilityRequest, UtilityResponse, TaskContract, WorkItemStage, SCHEMA_VERSION } from "../contracts/schemas.js";
import { CodeRelayDatabase } from "../persistence/database.js";
import { discoverExecutables, runCaptured } from "../platform/services.js";
import { runMilestoneZeroProof } from "../proofs/milestone-zero.js";
import { createStubFixture, runStubWorkflow } from "./stub-workflow.js";
import { runRealHandoff } from "./real-handoff.js";
import { inspectRepository } from "../repository/preflight.js";
import { TrustedGit, captureGitSnapshot } from "../repository/git.js";
import { sha256 } from "../security/redaction.js";
import { normalizeClaudeAuthentication, normalizeCodexAuthentication } from "../providers/auth.js";

const StartWorkItemPayload = z.object({
  repository: z.string().min(1),
  instruction: z.string().min(1),
  objective: z.string().min(1).optional(),
  allowedPaths: z.array(z.string().min(1)).min(1).default(["."]),
  prohibitedPaths: z.array(z.string().min(1)).default([]),
  validationCommand: z.object({ executable: z.string().min(1), args: z.array(z.string()).default([]) }).strict().optional(),
  worker: z.enum(["codex", "claude"]).default("codex"),
  confirmedUnpushed: z.boolean().default(false)
}).strict();

async function runnableExecutable(aliases: string[]): Promise<string | undefined> {
  for (const candidate of await discoverExecutables(aliases)) {
    const result = await runCaptured(candidate.path, ["--version"], { timeoutMs: 10_000 });
    if (result.exitCode === 0) return candidate.path;
  }
  return undefined;
}

async function providerStatus(provider: "codex" | "claude"): Promise<Record<string, unknown>> {
  const aliases = provider === "codex" ? ["codex", "codex.exe"] : ["claude", "claude.exe", "claude.cmd"];
  const executable = await runnableExecutable(aliases);
  if (!executable) return { provider, available: false, authState: "PROVIDER_UNAVAILABLE" };
  const version = await runCaptured(executable, ["--version"], { timeoutMs: 10_000 });
  const auth = await runCaptured(executable, provider === "codex" ? ["login", "status"] : ["auth", "status"], { timeoutMs: 15_000 });
  const normalized = provider === "codex" ? normalizeCodexAuthentication(auth) : normalizeClaudeAuthentication(auth);
  return { provider, available: true, version: version.stdout.trim() || version.stderr.trim(), authState: normalized.state };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function workingGit(): Promise<string> {
  for (const candidate of await discoverExecutables(["git", "git.exe"])) {
    const result = await runCaptured(candidate.path, ["--version"], { timeoutMs: 5_000 });
    if (result.exitCode === 0) return candidate.path;
  }
  throw new Error("Git is required for the orchestration utility");
}

async function main(): Promise<void> {
  const dataDirectory = path.resolve(argument("--data-dir") ?? path.join(process.cwd(), "work", "utility-data"));
  await mkdir(dataDirectory, { recursive: true });
  const database = await CodeRelayDatabase.open({
    databasePath: path.join(dataDirectory, "database", "coderelay.sqlite"),
    backupDirectory: path.join(dataDirectory, "backups")
  });
  database.pauseItemsWithUnreconciledProcesses();
  const gitExecutable = await workingGit();
  const startErrors = new Map<string, string>();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let shuttingDown = false;

  const write = (response: unknown): void => { process.stdout.write(`${JSON.stringify(response)}\n`); };
  input.on("line", (line) => {
    void handle(line).catch((error: unknown) => {
      write({ schemaVersion: SCHEMA_VERSION, requestId: "00000000-0000-4000-8000-000000000000", correlationId: "00000000-0000-4000-8000-000000000000", ok: false, error: { code: "UNHANDLED", message: error instanceof Error ? error.message : String(error) } });
    });
  });

  async function handle(line: string): Promise<void> {
    let request;
    try { request = UtilityRequest.parse(JSON.parse(line)); }
    catch (error) {
      write(UtilityResponse.parse({
        schemaVersion: SCHEMA_VERSION,
        requestId: "00000000-0000-4000-8000-000000000000",
        correlationId: "00000000-0000-4000-8000-000000000000",
        ok: false,
        error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) }
      }));
      return;
    }
    const existing = database.beginIdempotent(request.idempotencyKey, request.method);
    if (existing.state === "completed" || existing.state === "failed") {
      const stored = UtilityResponse.parse(existing.response);
      write(UtilityResponse.parse({
        ...stored,
        requestId: request.requestId,
        correlationId: request.correlationId
      }));
      return;
    }
    if (existing.state === "in_flight") {
      write(response(request, false, undefined, { code: "REQUEST_IN_FLIGHT", message: "The idempotency key is already running" }));
      return;
    }
    try {
      const result = await dispatch(request.method, request.payload);
      const value = response(request, true, result);
      database.finishIdempotent(request.idempotencyKey, value);
      write(value);
      if (request.method === "shutdown") {
        shuttingDown = true;
        input.close();
        database.close();
      }
    } catch (error) {
      const value = response(request, false, undefined, { code: "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) });
      database.finishIdempotent(request.idempotencyKey, value, true);
      write(value);
    }
  }

  async function dispatch(method: UtilityRequest["method"], payload: unknown): Promise<unknown> {
    if (method === "health") return { status: "ok", processId: process.pid, databaseIntegrity: database.integrityCheck() };
    if (method === "probe") return await runMilestoneZeroProof();
    if (method === "shutdown") return { status: "stopping" };
    if (method === "run_stub_workflow") {
      const inputPayload = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const worker = inputPayload.worker === "claude" ? "claude" : "codex";
      const fixture = await createStubFixture(gitExecutable);
      return await runStubWorkflow({
        database,
        repository: fixture.root,
        gitExecutable,
        worktreesDirectory: fixture.worktrees,
        worker,
        ...(Array.isArray(inputPayload.workerScenarios) ? { workerScenarios: inputPayload.workerScenarios as never[] } : {}),
        ...(Array.isArray(inputPayload.auditorScenarios) ? { auditorScenarios: inputPayload.auditorScenarios as never[] } : {})
      });
    }
    if (method === "provider_status") {
      const [codex, claude] = await Promise.all([providerStatus("codex"), providerStatus("claude")]);
      return { codex, claude };
    }
    if (method === "preflight_repository") {
      const repository = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).repository === "string"
        ? (payload as Record<string, unknown>).repository as string : "";
      if (!repository) throw new Error("repository is required");
      return await inspectRepository(repository, gitExecutable);
    }
    if (method === "list_work_items") {
      return { workItems: database.listWorkItems() };
    }
    if (method === "start_work_item") {
      const start = StartWorkItemPayload.parse(payload ?? {});
      const codex = await runnableExecutable(["codex", "codex.exe"]);
      const claude = await runnableExecutable(["claude", "claude.exe", "claude.cmd"]);
      if (!codex || !claude) throw new Error(`PROVIDER_UNAVAILABLE: ${!codex ? "codex" : ""}${!codex && !claude ? " and " : ""}${!claude ? "claude" : ""} not runnable on PATH`);
      const preflight = await inspectRepository(start.repository, gitExecutable);
      if (!preflight.clean) throw new Error("PRIMARY_CHECKOUT_DIRTY: commit, stash, or clean the repository before starting");
      if (preflight.requiresUnpushedConfirmation && !start.confirmedUnpushed) {
        throw new Error("UNPUSHED_BASE_REQUIRES_CONFIRMATION: the base commit is not pushed; confirm to proceed without pushing");
      }
      let validationCommands: { executable: string; args: string[]; cwd: string }[] = [];
      if (start.validationCommand) {
        const named = start.validationCommand.executable;
        const resolved = path.isAbsolute(named) ? named : await runnableExecutable([named, `${named}.exe`, `${named}.cmd`]);
        if (!resolved) throw new Error(`VALIDATION_EXECUTABLE_UNRESOLVED: ${named} is not runnable on PATH`);
        validationCommands = [{ executable: resolved, args: start.validationCommand.args, cwd: "." }];
      }
      const workItemId = `wi_${randomUUID()}`;
      const prohibited = [...new Set([".git", ...start.prohibitedPaths])];
      void runRealHandoff({
        database,
        repository: preflight.canonicalRoot,
        worktreesDirectory: path.join(dataDirectory, "worktrees"),
        artifactsDirectory: path.join(dataDirectory, "artifacts", workItemId),
        gitExecutable,
        executables: { codex, claude },
        worker: start.worker,
        workItemId,
        deterministicFixture: false,
        confirmedUnpushed: start.confirmedUnpushed,
        task: {
          objective: start.objective ?? start.instruction.slice(0, 120),
          userInstruction: start.instruction,
          acceptanceCriteria: [
            "The change implements the user instruction within the allowed paths",
            ...(validationCommands.length > 0 ? ["Authoritative orchestrator validation passes"] : []),
            "A fresh independent Auditor approves"
          ],
          allowedPaths: start.allowedPaths,
          prohibitedPaths: prohibited,
          validationCommands
        }
      }).then((result) => {
        database.appendEvent(workItemId, "work_item.run_finished", { status: result.status, branch: result.branch, finalCommit: result.finalCommit });
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        startErrors.set(workItemId, message);
        if (database.getWorkItem(workItemId)) {
          database.appendEvent(workItemId, "work_item.run_error", { message });
        }
      });
      return { workItemId, branch: `coderelay/${workItemId}`, worker: start.worker, repository: preflight.canonicalRoot };
    }
    const object = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const workItemId = typeof object.workItemId === "string" ? object.workItemId : "";
    if (!workItemId) throw new Error("workItemId is required");
    const item = database.getWorkItem(workItemId);
    if (!item) {
      const startError = startErrors.get(workItemId);
      if (method === "get_work_item" && startError) return { workItem: null, events: [], startError };
      throw new Error(`Unknown Work Item ${workItemId}`);
    }
    if (method === "get_work_item") return { workItem: item, events: database.listEvents(workItemId), startError: startErrors.get(workItemId) ?? null };
    const stage = WorkItemStage.parse(item.stage);
    if (method === "pause") {
      if (["COMPLETED", "ABORTED", "FAILED"].includes(String(item.status))) throw new Error(`Cannot pause terminal Work Item ${item.status}`);
      database.transition(workItemId, stage, "PAUSED", "user.paused", { safeBoundary: true });
      return database.getWorkItem(workItemId);
    }
    if (method === "resume") {
      if (!["PAUSED", "BLOCKED"].includes(String(item.status))) throw new Error(`Resume requires PAUSED or BLOCKED status, got ${item.status}`);
      const checkpoint = database.latestCheckpoint(workItemId);
      if (!checkpoint) throw new Error("No safe checkpoint exists");
      const git = new TrustedGit({ executable: gitExecutable, repository: String(item.worktree_root) });
      const snapshot = await captureGitSnapshot(git);
      if (snapshot.head !== checkpoint.commitHash || snapshot.status !== "" || snapshot.branch !== item.branch) {
        database.appendEvent(workItemId, "recovery.mismatch", { expectedCommit: checkpoint.commitHash, actualCommit: snapshot.head, statusHash: sha256(snapshot.status) });
        throw new Error("RECOVERY_MISMATCH: worktree does not match the last safe checkpoint");
      }
      database.transition(workItemId, stage, "ACTIVE", "user.resumed", { checkpoint: checkpoint.commitHash });
      return database.getWorkItem(workItemId);
    }
    if (method === "intervene") {
      if (["COMPLETED", "ABORTED"].includes(String(item.status))) throw new Error(`A terminal Work Item cannot be revised: ${item.status}`);
      const instruction = typeof object.instruction === "string" ? object.instruction : "";
      if (!instruction) throw new Error("instruction is required");
      const previous = database.getTaskContract(workItemId);
      if (!previous) throw new Error("TaskContract not found");
      const worktreeGit = new TrustedGit({ executable: gitExecutable, repository: String(item.worktree_root) });
      const interventionSnapshot = await captureGitSnapshot(worktreeGit);
      if (interventionSnapshot.branch !== item.branch) throw new Error("INTERVENTION_BRANCH_MISMATCH");
      const changed = [...new Set([
        ...interventionSnapshot.status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/^.* -> /, "").replaceAll("\\", "/")),
        ...interventionSnapshot.untrackedFiles.map((file) => file.replaceAll("\\", "/"))
      ])];
      const permitted = (file: string): boolean => {
        const matches = (candidate: string): boolean => {
          const value = candidate.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
          return value === "." || file === value || file.startsWith(`${value}/`);
        };
        return previous.allowedPaths.some(matches) && !previous.prohibitedPaths.some(matches) && !file.split("/").some((part) => part.toLowerCase() === ".git");
      };
      if (changed.some((file) => !permitted(file))) {
        database.appendEvent(workItemId, "intervention.scope_mismatch", { changedPathHashes: changed.map(sha256) });
        throw new Error("INTERVENTION_SCOPE_MISMATCH: refusing to checkpoint prohibited paths");
      }
      let checkpointCommit = interventionSnapshot.head;
      if (interventionSnapshot.status !== "") {
        await worktreeGit.run(["add", "--all"]);
        await worktreeGit.run(["commit", "-m", `CodeRelay intervention checkpoint before contract ${previous.revision + 1}`]);
        checkpointCommit = (await worktreeGit.run(["rev-parse", "HEAD"])).trim();
      }
      database.saveCheckpoint(workItemId, stage, checkpointCommit, await captureGitSnapshot(worktreeGit));
      const revised = TaskContract.parse({
        ...previous,
        revision: previous.revision + 1,
        parentHash: sha256(JSON.stringify(previous)),
        userInstruction: instruction,
        createdAt: new Date().toISOString()
      });
      database.addTaskContractRevision(revised);
      const assignment = database.latestRoleAssignment(workItemId);
      if (!assignment) throw new Error("RoleAssignment not found for intervention routing");
      const packets = ([
        { provider: assignment.worker, role: "WORKER" as const },
        { provider: assignment.auditor, role: "AUDITOR" as const }
      ]).map((recipient) => HandoffPacket.parse({
        schemaVersion: SCHEMA_VERSION,
        workItemId,
        from: { provider: "orchestrator", role: "ORCHESTRATOR" },
        to: recipient,
        fromStage: stage,
        toStage: "PLANNING",
        iteration: Number(item.iteration ?? 0),
        summary: `TaskContract revised by user intervention: ${instruction}`,
        taskContractVersion: revised.revision,
        planVersion: 1,
        decisions: ["Pause and replan against the revised TaskContract"],
        evidenceRefs: [`checkpoint:${checkpointCommit}`],
        changedFiles: changed,
        diffHash: interventionSnapshot.fingerprint,
        validationRefs: [],
        findings: [],
        resolvedFindingIds: [],
        unresolvedFindingIds: [],
        assumptions: [],
        blockers: [],
        recommendedNextAction: "Re-evaluate scope, acceptance, validation, risk, and roles before resuming",
        contextBriefRefs: [],
        createdAt: new Date().toISOString()
      }));
      packets.forEach((packet) => database.saveHandoff(packet));
      database.appendEvent(workItemId, "handoff.revision_required", { contractRevision: revised.revision, recipients: packets.map((packet) => packet.to.provider), replanRequired: true, checkpointCommit });
      return { workItem: database.getWorkItem(workItemId), contract: revised };
    }
    throw new Error(`Unsupported method ${method}`);
  }

  function response(
    request: UtilityRequest,
    ok: boolean,
    result?: unknown,
    error?: { code: string; message: string }
  ) {
    return UtilityResponse.parse({
      schemaVersion: SCHEMA_VERSION,
      requestId: request.requestId,
      correlationId: request.correlationId,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {})
    });
  }

  process.on("exit", () => { if (!shuttingDown) { try { database.close(); } catch { /* already closed */ } } });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
