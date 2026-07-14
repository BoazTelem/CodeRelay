import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodeRelayDatabase } from "../src/persistence/database.js";
import { SCHEMA_VERSION, TaskContract } from "../src/contracts/schemas.js";
import { createStubFixture } from "../src/orchestrator/stub-workflow.js";
import { discoverExecutables, runCaptured } from "../src/platform/services.js";
import { assertRepositoryMayStart, inspectRepository } from "../src/repository/preflight.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

async function gitExecutable(): Promise<string> {
  for (const candidate of await discoverExecutables(["git", "git.exe"])) {
    if ((await runCaptured(candidate.path, ["--version"])).exitCode === 0) return candidate.path;
  }
  throw new Error("Git not found");
}

describe("SQLite durability", () => {
  test("enables WAL/foreign keys, migrates transactionally, and enforces one Worker lease", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "coderelay-db-test-"));
    temporary.push(base);
    const databasePath = path.join(base, "db", "coderelay.sqlite");
    const backupDirectory = path.join(base, "backups");
    const db = await CodeRelayDatabase.open({ databasePath, backupDirectory });
    expect((db.connection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    expect((db.connection.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.connection.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    const contract = TaskContract.parse({
      schemaVersion: SCHEMA_VERSION, workItemId: "wi_db", revision: 1, parentHash: null, objective: "test", userInstruction: "test",
      acceptanceCriteria: ["pass"], allowedPaths: ["src"], prohibitedPaths: [".git"], validationCommands: [], risks: [], humanAuthorizations: [],
      createdBy: "user", createdAt: new Date().toISOString()
    });
    db.createWorkItem({ id: "wi_db", title: "db", repositoryRootHash: "hash", primaryRoot: "primary", worktreeRoot: "worktree", baseCommit: "base", branch: "coderelay/wi_db", stage: "IMPLEMENTATION", status: "ACTIVE", contract });
    db.acquireWorkerLease("wi_db", "owner1", "IMPLEMENTATION");
    expect(() => db.acquireWorkerLease("wi_db", "owner2", "IMPLEMENTATION")).toThrow("WORKER_LEASE_CONFLICT");
    db.releaseWorkerLease("wi_db", "owner1");
    expect(db.integrityCheck()).toBe(true);
    db.close();
    const reopened = await CodeRelayDatabase.open({ databasePath, backupDirectory });
    expect(reopened.getWorkItem("wi_db")?.status).toBe("ACTIVE");
    reopened.close();
    expect((await readdir(backupDirectory)).length).toBeLessThanOrEqual(3);
  });
});

describe("read-only repository preflight", () => {
  test("records a clean repository and refuses nonignored untracked changes without mutating them", async () => {
    const git = await gitExecutable();
    const fixture = await createStubFixture(git);
    temporary.push(path.dirname(fixture.root));
    const clean = await inspectRepository(fixture.root, git);
    expect(clean.clean).toBe(true);
    assertRepositoryMayStart(clean);
    await writeFile(path.join(fixture.root, "untracked.txt"), "leave me\n");
    const dirty = await inspectRepository(fixture.root, git);
    expect(dirty.untracked).toContain("untracked.txt");
    expect(() => assertRepositoryMayStart(dirty)).toThrow("PRIMARY_CHECKOUT_DIRTY");
    expect(await writeFile(path.join(fixture.root, "proof.tmp"), "still writable\n").then(() => true)).toBe(true);
  });
});

