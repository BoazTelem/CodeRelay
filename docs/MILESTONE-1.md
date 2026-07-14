# Milestone 1 Stub Orchestration Prototype

The prototype is a console client communicating over versioned JSONL IPC with a separate orchestration utility process. It has no Electron renderer or polished desktop UI.

Run:

```powershell
npm run prototype
```

The demonstration creates a disposable clean Git repository, isolated `coderelay/*` worktree, SQLite database in WAL mode, TaskContract, role assignments, Worker lease, structured Context Brief and Handoff Packets, and stub Codex/Claude child processes. It intentionally emits one invalid schema, corrects it once, performs a Worker change through the path broker, runs authoritative validation, obtains a fresh Auditor change request, resumes through rework, validates again, receives fresh approval, creates trusted checkpoint commits, verifies the primary checkout fingerprint, and completes.

The contract suite also covers the reverse Claude Worker → Codex Auditor route, strict auth normalization, subscription exhaustion pause, default-deny commands, executable substitution, traversal/link/junction/`.git` escapes, optimistic patch hashes, repeated violation rollback/blocking, one active Worker lease, dirty-repository refusal, external-session quarantine, idempotent IPC replay, database migration/backup/integrity, exact prompt snapshots, and schema examples.

Stub success is not real-provider evidence and cannot satisfy Milestone 2 or authorize later work.

