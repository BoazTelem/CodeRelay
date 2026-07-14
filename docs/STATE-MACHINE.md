# Workflow State Machine

**Schema version:** 1.0.0  
**Status:** normative

## 1. Work Item aggregate

A Work Item persists `id`, `title`, canonical repository identity, base commit, isolated branch/worktree, user request, current TaskContract revision, starting provider/session reference, role configuration, purpose-specific session references, current stage, iteration and limits, approved plan, acceptance criteria, findings, validation, handoffs, checkpoints, leases, evidence references, status, pause/block reason, and timestamps.

Statuses are `ACTIVE`, `PAUSED`, `COMPLETED`, `BLOCKED`, `FAILED`, and `ABORTED`. Stages are `PREFLIGHT`, `CONTEXT_CAPTURE`, `PRODUCT_CHALLENGE`, `PLANNING`, `PLAN_AUDIT`, `IMPLEMENTATION`, `VALIDATION`, `REVIEW`, `REWORK`, `FINAL_VALIDATION`, `FINAL_VERIFICATION`, and `COMPLETION_EVALUATION`.

## 2. Transition table

| Current | Event/guard | Next | Required durable effects |
|---|---|---|---|
| none | clean preflight and subscription proof | `PREFLIGHT/ACTIVE` | repository snapshot, auth proofs, Work Item, contract v1 |
| any active | user pause | same stage/`PAUSED` | finish/cancel bounded turn, snapshot, release lease |
| paused | compatible resume and successful reconciliation | recorded stage/`ACTIVE` | new auth proof and recovery event |
| any nonterminal | user stop | same stage/`ABORTED` | cancel, reconcile, final abort report |
| context capture | valid brief | product challenge or planning | brief and compatibility evidence |
| product challenge | valid result | planning | challenge artifact and criteria draft |
| planning | valid plan | plan audit | plan revision and handoff |
| plan audit | approve | implementation | approved plan, assignment, checkpoint |
| plan audit | revise and below limit | planning | findings and plan revision request |
| implementation/rework | valid, in-scope result | validation | post-turn snapshot and output artifact |
| implementation/rework | first scope violation | same Worker stage | violation evidence, rollback, correction count |
| implementation/rework | repeated scope violation | same stage/`BLOCKED` | rollback, block record |
| validation | pass | review or final validation | authoritative command evidence, checkpoint |
| validation | fail and attempts remain | rework | failure fingerprint and focused repair packet |
| review | approve | final validation | fresh-session audit result |
| review | changes and attempts remain | rework | findings and repair packet |
| final validation | pass | final verification | complete validation evidence |
| final verification | approve | completion evaluation | fresh verifier result |
| completion evaluation | every completion guard true | same/`COMPLETED` | trusted commit, final report, evidence hashes |
| any active | missing provider/subscription | same/`PAUSED` | normalized failure and reauth requirement |
| any active | blocking guard | same/`BLOCKED` | evidence and explicit resume requirement |
| startup | recovery mismatch | recorded stage/`PAUSED` | reconciliation report; no provider launch |

Every transition is one SQLite transaction containing the aggregate update and an append-only event. External process start uses an idempotency key and a two-phase intent/started record so a crash cannot silently duplicate a turn.

## 3. Guards

Before a Work Item begins: primary checkout clean, explicit approval for unpushed base when applicable, no duplicate active Work Item, both provider auth states `SUBSCRIPTION_VERIFIED`, required capability proofs current, worktree created from recorded base, and contract accepted.

Before a provider turn: status active, stage permits provider, persisted RoleAssignment matches purpose/access, no incompatible session reuse, Worker lease held for a writing turn, command/path policy digest current, checkpoint reconciled, and TaskContract version included.

Before a checkpoint: provider stopped, paths and Git state compliant, authoritative stage validation recorded, and no other lease. Only the orchestrator's trusted Git executable may create the commit.

Before completion: all guards in `COMPLETION-RULES.md` pass.

## 4. TaskContract revision

TaskContract revisions are immutable and monotonically numbered. A user intervention creates `revision = previous + 1` with user instruction, parent hash, acceptance criteria, approved/prohibited paths, validation profile, risks, role effects, human authorizations, timestamp, and author. The Work Item pauses until compatibility is re-evaluated. Both providers receive the revision on their next turns through a new Handoff Packet.

## 5. Lease state

`worker_leases` has at most one live row per Work Item. It records owner process identity, stage, acquired/heartbeat/expiry times, and release reason. Startup never assumes an expired lease means a provider is dead; it verifies the recorded process identity, terminates only a proven orphan, reconciles Git state, then releases or blocks.

## 6. Recovery

Startup enables foreign keys and WAL, runs `quick_check`, identifies incomplete transition/process intents, checks recorded process identity, enumerates CodeRelay worktrees, and compares base/checkpoint/current branch, HEAD, index, working diff, untracked manifest, and lease. A complete match can resume at the last safe stage. Any unexplained process, Git, filesystem, schema, or artifact mismatch pauses and produces a reconciliation report.

Database corruption is never auto-repaired in place. Quarantine the database and its WAL/SHM files, stop orchestration, and offer restoration from a verified migration backup or redacted artifact export.

## 7. IPC lifecycle

Utility requests use `{schemaVersion, requestId, correlationId, idempotencyKey, method, payload}`. Results/events echo correlation identity. Repeating a completed idempotency key returns the stored response. Repeating an in-flight non-idempotent action reports its status and does not launch a duplicate process.

Renderer or Electron-main disconnect changes no Work Item state. The utility continues and journals events. A reconnect requests events after the last observed monotonic sequence.

