# Role Configuration

**Specification version:** 1.0.0-proof  
**Status:** normative

## 1. Roles

- `WORKER`: inspect and modify only approved worktree files, add or update allowed tests, use broker-approved commands, repair validated failures and review findings, and report structured results. Access is `workspace-write`.
- `AUDITOR`: inspect the contract, plan, diff, repository rules, validation evidence, and findings; issue a structured approval/revision/block decision. Access is `read-only`; it never modifies files.
- `PLANNER`: create a technical plan without modifying files. Access is `read-only`.
- `PRODUCT_CHALLENGER`: test product value, assumptions, scope, and acceptance criteria without modifying files. Access is `read-only`.
- `FINAL_VERIFIER`: independently evaluate complete acceptance and safety evidence in a fresh `read-only` session; it never modifies files.

Only the orchestrator assigns roles. A provider can recommend but cannot switch roles, grant itself tools, choose the next stage, approve its own implementation, or declare completion.

## 2. Routing modes

### Fixed

One provider remains Worker and the other Auditor. This is the recommended default: Codex Worker, Claude Auditor. The providers must differ.

### Both-capable

Each provider has explicit capability toggles for work, audit, plan, and final verification. The orchestrator selects primary and secondary assignments per stage. A session that implemented an iteration cannot audit it, the other provider audits each completed iteration, and final verification is fresh and cannot use the most recent Worker.

### Alternating

Worker/Auditor assignments switch at the configured trigger: after every audited iteration, after changes are requested, after auditor approval, or only on manual request. Switching occurs only at a safe stage boundary after a checkpoint and handoff. `maxConsecutiveWorkerIterations` prevents one provider retaining the Worker role indefinitely.

### Manual

The user chooses future assignments only while paused or at a safe stage boundary. An override checkpoints the worktree, persists the reason, produces a handoff, starts role-compatible sessions, and informs both providers. It never interrupts an uncontrolled writer or changes the access of an already running process.

## 3. Canonical configuration example

```json
{
  "schemaVersion": "1.0.0",
  "mode": "fixed",
  "initialWorker": "codex",
  "initialAuditor": "claude",
  "capabilities": {
    "codex": { "canWork": true, "canAudit": true, "canPlan": true, "canFinalVerify": true },
    "claude": { "canWork": true, "canAudit": true, "canPlan": true, "canFinalVerify": true }
  },
  "switching": {
    "enabled": false,
    "trigger": "manual",
    "maxConsecutiveWorkerIterations": 1
  },
  "finalVerification": {
    "provider": "automatic",
    "freshSessionRequired": true,
    "prohibitLatestWorker": true
  }
}
```

## 4. Persisted assignment

Before every stage the orchestrator persists a `RoleAssignment` with schema version, Work Item, stage, iteration, Worker/Auditor provider and session IDs where applicable, access modes, previous assignment, switching reason, and timestamp. Reasons are `initial_configuration`, `fixed_assignment`, `scheduled_alternation`, `audit_requested_changes`, `user_override`, and `provider_unavailable`.

The active coordination envelope tells a provider its current role and access but never invites it to act as another role. A switch starts a new role-purpose-specific session; an audit session never becomes a Worker session and an implementation session never becomes an independent review session.

## 5. Concurrency and independence

One database-backed Worker lease is the maximum. Lease acquisition and expiration are transactional. Provider processes never write concurrently. A review is independent only when its session is fresh for `REVIEW` or `FINAL_REVIEW`, read-only, did not implement the reviewed change, and receives current state through structured artifacts rather than a reused Worker transcript.

If a provider is unavailable, the default is pause. A user may explicitly switch to a capable provider, but that provider still cannot audit its own work. There is no automatic cloud, API, or authentication fallback.

## 6. UI requirements for post-GO work

The future Agent Roles screen shows mode, capability toggles, initial roles, switching trigger, final verifier policy, and validation errors such as same-provider fixed roles. The live Work Item screen shows iteration, assigned providers, session purposes, access modes, switching reason, and Worker lease. These requirements are specified now but not implemented before `GO`.

