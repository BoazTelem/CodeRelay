import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { HandoffPacket, RoleAssignment, TaskContract, WorkItemStage, WorkItemStatus } from "../contracts/schemas.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "event-and-proof-foundation",
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX events_work_item_sequence ON events(work_item_id, sequence);
      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('in_flight','completed','failed')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE provider_proofs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        proof_type TEXT NOT NULL,
        normalized_state TEXT,
        evidence_json TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: "workflow-aggregate",
    sql: `
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repository_root_hash TEXT NOT NULL,
        primary_root TEXT NOT NULL,
        worktree_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        current_contract_revision INTEGER NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_contracts (
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(work_item_id, revision)
      );
      CREATE TABLE role_assignments (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        assignment_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        role TEXT NOT NULL,
        purpose TEXT NOT NULL,
        native_id_hash TEXT NOT NULL,
        fresh INTEGER NOT NULL CHECK(fresh IN (0,1)),
        compatible INTEGER NOT NULL CHECK(compatible IN (0,1)),
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        iteration INTEGER NOT NULL,
        packet_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE validation_results (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        iteration INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE findings (
        id TEXT NOT NULL,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        iteration INTEGER NOT NULL,
        finding_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(id, work_item_id)
      );
      CREATE TABLE worker_leases (
        work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE recorded_processes (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        pid INTEGER NOT NULL,
        executable_hash TEXT NOT NULL,
        process_start_identity TEXT NOT NULL,
        capability_nonce_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 3,
    name: "artifacts-and-retention",
    sql: `
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        redacted INTEGER NOT NULL CHECK(redacted IN (0,1)),
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  }
];

export class DatabaseCorruptionError extends Error {
  constructor(message: string, readonly quarantinePath: string) {
    super(message);
    this.name = "DatabaseCorruptionError";
  }
}

export interface OpenDatabaseOptions {
  databasePath: string;
  backupDirectory: string;
  now?: () => Date;
}

export class CodeRelayDatabase {
  private constructor(readonly connection: DatabaseSync, readonly path: string) {}

  static async open(options: OpenDatabaseOptions): Promise<CodeRelayDatabase> {
    await mkdir(path.dirname(options.databasePath), { recursive: true });
    await mkdir(options.backupDirectory, { recursive: true });
    const existed = await stat(options.databasePath).then(() => true, () => false);
    const db = new DatabaseSync(options.databasePath);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const quick = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (!quick.every((row) => row.quick_check === "ok")) {
      db.close();
      const quarantine = `${options.databasePath}.corrupt-${(options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-")}`;
      await rename(options.databasePath, quarantine);
      for (const suffix of ["-wal", "-shm"]) {
        await rename(`${options.databasePath}${suffix}`, `${quarantine}${suffix}`).catch(() => undefined);
      }
      throw new DatabaseCorruptionError("SQLite quick_check failed; the database was quarantined", quarantine);
    }

    const currentVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    for (const migration of MIGRATIONS.filter((entry) => entry.version > currentVersion)) {
      if (existed || migration.version > 1) {
        const backupName = `migration-v${migration.version}-${Date.now()}.sqlite`;
        const backupPath = path.join(options.backupDirectory, backupName);
        await backup(db, backupPath);
        const verified = new DatabaseSync(backupPath, { readOnly: true });
        const check = verified.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
        verified.close();
        await rm(`${backupPath}-wal`, { force: true });
        await rm(`${backupPath}-shm`, { force: true });
        if (!check.every((row) => row.quick_check === "ok")) {
          await rm(backupPath, { force: true });
          db.close();
          throw new Error(`Backup verification failed before migration ${migration.version}`);
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        db.exec(`PRAGMA user_version = ${migration.version}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
      }
    }
    await retainLatestBackups(options.backupDirectory, 3);
    return new CodeRelayDatabase(db, options.databasePath);
  }

  close(): void { this.connection.close(); }

  integrityCheck(): boolean {
    const rows = this.connection.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    return rows.every((row) => row.integrity_check === "ok");
  }

  appendEvent(workItemId: string | null, eventType: string, payload: unknown): number {
    const result = this.connection.prepare("INSERT INTO events(work_item_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(workItemId, eventType, JSON.stringify(payload), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  listEvents(workItemId: string, afterSequence = 0): Array<{ sequence: number; eventType: string; payload: unknown; createdAt: string }> {
    const rows = this.connection.prepare("SELECT sequence, event_type, payload_json, created_at FROM events WHERE work_item_id = ? AND sequence > ? ORDER BY sequence")
      .all(workItemId, afterSequence) as Array<{ sequence: number; event_type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ sequence: row.sequence, eventType: row.event_type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  beginIdempotent(key: string, method: string): { state: "new" | "in_flight" | "completed" | "failed"; response?: unknown } {
    const row = this.connection.prepare("SELECT state, response_json FROM idempotency_keys WHERE key = ?").get(key) as { state: string; response_json: string | null } | undefined;
    if (row) return { state: row.state as "in_flight" | "completed" | "failed", ...(row.response_json ? { response: JSON.parse(row.response_json) } : {}) };
    const now = new Date().toISOString();
    this.connection.prepare("INSERT INTO idempotency_keys(key, method, state, created_at, updated_at) VALUES (?, ?, 'in_flight', ?, ?)").run(key, method, now, now);
    return { state: "new" };
  }

  finishIdempotent(key: string, response: unknown, failed = false): void {
    this.connection.prepare("UPDATE idempotency_keys SET state = ?, response_json = ?, updated_at = ? WHERE key = ?")
      .run(failed ? "failed" : "completed", JSON.stringify(response), new Date().toISOString(), key);
  }

  createWorkItem(input: {
    id: string; title: string; repositoryRootHash: string; primaryRoot: string; worktreeRoot: string;
    baseCommit: string; branch: string; stage: WorkItemStage; status: WorkItemStatus; contract: TaskContract;
  }): void {
    const now = new Date().toISOString();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.prepare(`INSERT INTO work_items(id,title,repository_root_hash,primary_root,worktree_root,base_commit,branch,stage,status,current_contract_revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.title, input.repositoryRootHash, input.primaryRoot, input.worktreeRoot, input.baseCommit, input.branch, input.stage, input.status, input.contract.revision, now, now);
      this.insertTaskContract(input.contract);
      this.appendEvent(input.id, "work_item.created", { stage: input.stage, status: input.status, contractRevision: input.contract.revision });
      this.connection.exec("COMMIT");
    } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }

  insertTaskContract(contract: TaskContract): void {
    const value = JSON.stringify(contract);
    const hash = `sha256:${createHash("sha256").update(value).digest("hex")}`;
    this.connection.prepare("INSERT INTO task_contracts(work_item_id,revision,contract_json,contract_hash,created_at) VALUES (?,?,?,?,?)")
      .run(contract.workItemId, contract.revision, value, hash, contract.createdAt);
  }

  addTaskContractRevision(contract: TaskContract): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const row = this.connection.prepare("SELECT current_contract_revision FROM work_items WHERE id = ?").get(contract.workItemId) as { current_contract_revision: number } | undefined;
      if (!row || contract.revision !== row.current_contract_revision + 1) throw new Error("TaskContract revision must increment exactly once");
      this.insertTaskContract(contract);
      this.connection.prepare("UPDATE work_items SET current_contract_revision = ?, status = 'PAUSED', updated_at = ? WHERE id = ?")
        .run(contract.revision, new Date().toISOString(), contract.workItemId);
      this.appendEvent(contract.workItemId, "task_contract.revised", { revision: contract.revision, contract });
      this.connection.exec("COMMIT");
    } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }

  getTaskContract(workItemId: string, revision?: number): TaskContract | undefined {
    const row = revision === undefined
      ? this.connection.prepare("SELECT contract_json FROM task_contracts WHERE work_item_id = ? ORDER BY revision DESC LIMIT 1").get(workItemId)
      : this.connection.prepare("SELECT contract_json FROM task_contracts WHERE work_item_id = ? AND revision = ?").get(workItemId, revision);
    return row ? JSON.parse((row as { contract_json: string }).contract_json) as TaskContract : undefined;
  }

  latestCheckpoint(workItemId: string): { commitHash: string; snapshot: unknown; stage: string } | undefined {
    const row = this.connection.prepare("SELECT commit_hash, snapshot_json, stage FROM checkpoints WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(workItemId) as { commit_hash: string; snapshot_json: string; stage: string } | undefined;
    return row ? { commitHash: row.commit_hash, snapshot: JSON.parse(row.snapshot_json), stage: row.stage } : undefined;
  }

  latestRoleAssignment(workItemId: string): RoleAssignment | undefined {
    const row = this.connection.prepare("SELECT assignment_json FROM role_assignments WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(workItemId) as { assignment_json: string } | undefined;
    return row ? JSON.parse(row.assignment_json) as RoleAssignment : undefined;
  }

  transition(workItemId: string, stage: WorkItemStage, status: WorkItemStatus, eventType: string, payload: unknown): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = this.connection.prepare("UPDATE work_items SET stage = ?, status = ?, updated_at = ? WHERE id = ?").run(stage, status, new Date().toISOString(), workItemId);
      if (result.changes !== 1) throw new Error(`Unknown Work Item ${workItemId}`);
      this.appendEvent(workItemId, eventType, payload);
      this.connection.exec("COMMIT");
    } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }

  saveRoleAssignment(assignment: RoleAssignment): string {
    const id = `ra_${randomUUID()}`;
    this.connection.prepare("INSERT INTO role_assignments(id,work_item_id,stage,iteration,assignment_json,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, assignment.workItemId, assignment.stage, assignment.iteration, JSON.stringify(assignment), assignment.createdAt);
    return id;
  }

  saveHandoff(packet: HandoffPacket): string {
    const id = `ho_${randomUUID()}`;
    this.connection.prepare("INSERT INTO handoffs(id,work_item_id,iteration,packet_json,created_at) VALUES (?,?,?,?,?)")
      .run(id, packet.workItemId, packet.iteration, JSON.stringify(packet), packet.createdAt);
    return id;
  }

  saveCheckpoint(workItemId: string, stage: string, commitHash: string, snapshot: unknown): string {
    const id = `cp_${randomUUID()}`;
    this.connection.prepare("INSERT INTO checkpoints(id,work_item_id,stage,commit_hash,snapshot_json,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, workItemId, stage, commitHash, JSON.stringify(snapshot), new Date().toISOString());
    return id;
  }

  acquireWorkerLease(workItemId: string, ownerId: string, stage: string, ttlMs = 60_000): void {
    const now = new Date();
    this.connection.prepare("DELETE FROM worker_leases WHERE work_item_id = ? AND expires_at < ?").run(workItemId, now.toISOString());
    try {
      this.connection.prepare("INSERT INTO worker_leases(work_item_id,owner_id,stage,acquired_at,heartbeat_at,expires_at) VALUES (?,?,?,?,?,?)")
        .run(workItemId, ownerId, stage, now.toISOString(), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
    } catch {
      throw new Error(`WORKER_LEASE_CONFLICT: ${workItemId} already has an active writer`);
    }
  }

  releaseWorkerLease(workItemId: string, ownerId: string): void {
    const result = this.connection.prepare("DELETE FROM worker_leases WHERE work_item_id = ? AND owner_id = ?").run(workItemId, ownerId);
    if (result.changes !== 1) throw new Error("WORKER_LEASE_OWNER_MISMATCH");
  }

  recordProcess(input: { id: string; workItemId: string; pid: number; executableHash: string; processStartIdentity: string; capabilityNonceHash: string }): void {
    const now = new Date().toISOString();
    this.connection.prepare("INSERT INTO recorded_processes(id,work_item_id,pid,executable_hash,process_start_identity,capability_nonce_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'running',?,?)")
      .run(input.id, input.workItemId, input.pid, input.executableHash, input.processStartIdentity, input.capabilityNonceHash, now, now);
  }

  stopRecordedProcess(id: string, state: "exited" | "cancelled" | "terminated"): void {
    this.connection.prepare("UPDATE recorded_processes SET state = ?, updated_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
  }

  pauseItemsWithUnreconciledProcesses(): number {
    const rows = this.connection.prepare("SELECT id, work_item_id, pid, executable_hash, process_start_identity FROM recorded_processes WHERE state = 'running'")
      .all() as Array<{ id: string; work_item_id: string; pid: number; executable_hash: string; process_start_identity: string }>;
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.connection.prepare("UPDATE work_items SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'ACTIVE'").run(new Date().toISOString(), row.work_item_id);
        this.connection.prepare("UPDATE recorded_processes SET state = 'orphan_pending', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
        this.appendEvent(row.work_item_id, "recovery.orphan_requires_identity_verification", {
          processRecordId: row.id,
          pid: row.pid,
          executableHash: row.executable_hash,
          processStartIdentity: row.process_start_identity
        });
      }
      this.connection.exec("COMMIT");
      return rows.length;
    } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }

  getWorkItem(id: string): Record<string, unknown> | undefined {
    const row = this.connection.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row;
  }
}

async function retainLatestBackups(directory: string, count: number): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(entries.slice(count).flatMap((name) => {
    const target = path.join(directory, name);
    return [rm(target, { force: true }), rm(`${target}-wal`, { force: true }), rm(`${target}-shm`, { force: true })];
  }));
}
