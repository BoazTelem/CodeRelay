import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodeRelayDatabase } from "../src/persistence/database.js";
import { createStubFixture, runStubWorkflow } from "../src/orchestrator/stub-workflow.js";
import { discoverExecutables, runCaptured } from "../src/platform/services.js";
import { UtilityProcessClient } from "../src/orchestrator/ipc-client.js";
import { StubProviderAdapter } from "../src/providers/stub-adapter.js";
import { WorkerResult } from "../src/contracts/schemas.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

async function gitExecutable(): Promise<string> {
  for (const candidate of await discoverExecutables(["git", "git.exe"])) if ((await runCaptured(candidate.path, ["--version"])).exitCode === 0) return candidate.path;
  throw new Error("Git not found");
}

async function database(base: string): Promise<CodeRelayDatabase> {
  return await CodeRelayDatabase.open({ databasePath: path.join(base, "db", "coderelay.sqlite"), backupDirectory: path.join(base, "backups") });
}

describe("Milestone 1 orchestration", () => {
  test("cancels a long-running provider process tree", { timeout: 20_000 }, async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "coderelay-cancel-test-"));
    temporary.push(base);
    const adapter = new StubProviderAdapter("stub-codex", ["timeout"], async () => undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250).unref();
    await expect(adapter.runTurn({
      workItemId: "wi_cancel", purpose: "IMPLEMENTATION", prompt: "wait", outputSchema: WorkerResult, schemaName: "WorkerResult",
      access: "workspace-write", customizationMode: "restricted", cwd: base, session: { mode: "new" }, timeoutMs: 15_000
    }, controller.signal)).rejects.toThrow("TURN_CANCELLED");
  });

  test("corrects one schema failure, routes rework, uses fresh audit sessions, and completes", { timeout: 60_000 }, async () => {
    const git = await gitExecutable();
    const fixture = await createStubFixture(git);
    const base = path.dirname(fixture.root);
    temporary.push(base);
    const db = await database(base);
    const report = await runStubWorkflow({
      database: db, repository: fixture.root, gitExecutable: git, worktreesDirectory: fixture.worktrees, worker: "codex",
      workerScenarios: ["schema-failure-once", "worker-rework"], auditorScenarios: ["auditor-changes", "auditor-approve"]
    });
    expect(report).toMatchObject({ status: "COMPLETED", iterations: 2, schemaCorrectionUsed: true, validationPassed: true, primaryCheckoutUntouched: true });
    expect(report.findings).toContainEqual(expect.objectContaining({ id: "finding_fixture", status: "resolved", blocking: false }));
    const events = db.listEvents(report.workItemId);
    expect(events.filter((event) => event.eventType === "audit.completed")).toHaveLength(2);
    expect(events.every((event) => !JSON.stringify(event.payload).includes("push succeeded"))).toBe(true);
    db.close();
  });

  test("supports the opposite Claude Worker to Codex Auditor direction", { timeout: 40_000 }, async () => {
    const git = await gitExecutable();
    const fixture = await createStubFixture(git);
    const base = path.dirname(fixture.root);
    temporary.push(base);
    const db = await database(base);
    const report = await runStubWorkflow({ database: db, repository: fixture.root, gitExecutable: git, worktreesDirectory: fixture.worktrees, worker: "claude" });
    expect(report).toMatchObject({ status: "COMPLETED", worker: "claude", auditor: "codex", iterations: 1 });
    db.close();
  });

  test("rolls back a first path violation and blocks a repeated violation", { timeout: 60_000 }, async () => {
    const git = await gitExecutable();
    const fixture = await createStubFixture(git);
    const base = path.dirname(fixture.root);
    temporary.push(base);
    const db = await database(base);
    const report = await runStubWorkflow({
      database: db, repository: fixture.root, gitExecutable: git, worktreesDirectory: fixture.worktrees, worker: "codex",
      workerScenarios: ["prohibited-path", "prohibited-path"]
    });
    expect(report.status).toBe("BLOCKED");
    const events = db.listEvents(report.workItemId);
    expect(events.filter((event) => event.eventType === "policy.violation_rollback")).toHaveLength(2);
    expect(events.at(-1)?.eventType).toBe("policy.repeated_violation");
    db.close();
  });

  test("pauses instead of switching authentication on subscription exhaustion", { timeout: 40_000 }, async () => {
    const git = await gitExecutable();
    const fixture = await createStubFixture(git);
    const base = path.dirname(fixture.root);
    temporary.push(base);
    const db = await database(base);
    const report = await runStubWorkflow({ database: db, repository: fixture.root, gitExecutable: git, worktreesDirectory: fixture.worktrees, worker: "codex", workerScenarios: ["subscription-failure"] });
    expect(report.status).toBe("PAUSED");
    expect(db.listEvents(report.workItemId).at(-1)?.eventType).toBe("provider.unavailable");
    db.close();
  });
});

describe("validated utility IPC", () => {
  test("survives independently and replays idempotent results with current correlation IDs", { timeout: 30_000 }, async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "coderelay-ipc-test-"));
    temporary.push(base);
    const client = new UtilityProcessClient(base);
    const key = "idempotency-health-proof";
    const first = await client.request("health", {}, key);
    const second = await client.request("health", {}, key);
    expect(first.ok).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.requestId).not.toBe(first.requestId);
    await client.close();
  });

  test("turns a user intervention into a checkpointed TaskContract revision routed to both providers", { timeout: 40_000 }, async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "coderelay-intervention-test-"));
    temporary.push(base);
    const client = new UtilityProcessClient(base);
    try {
      const paused = await client.request("run_stub_workflow", { worker: "codex", workerScenarios: ["subscription-failure"] });
      expect(paused.ok).toBe(true);
      const workItemId = (paused.result as { workItemId: string }).workItemId;
      const revision = await client.request("intervene", { workItemId, instruction: "Revise the fixture contract and replan both roles" });
      expect(revision.ok).toBe(true);
      expect((revision.result as { contract: { revision: number } }).contract.revision).toBe(2);
      const state = await client.request("get_work_item", { workItemId });
      const stateResult = state.result as { workItem: { worktree_root: string }; events: Array<{ eventType: string }> };
      const events = stateResult.events;
      expect(events.some((event) => event.eventType === "task_contract.revised")).toBe(true);
      expect(events.some((event) => event.eventType === "handoff.revision_required")).toBe(true);
      await writeFile(path.join(stateResult.workItem.worktree_root, "src", "crash-mismatch.txt"), "unreconciled\n", "utf8");
      const resume = await client.request("resume", { workItemId });
      expect(resume.ok).toBe(false);
      expect(resume.error?.message).toContain("RECOVERY_MISMATCH");
      const after = await client.request("get_work_item", { workItemId });
      expect((after.result as { events: Array<{ eventType: string }> }).events.some((event) => event.eventType === "recovery.mismatch")).toBe(true);
    } finally {
      await client.close();
    }
  });
});
