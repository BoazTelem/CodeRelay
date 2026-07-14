# Orchestration Protocol

**Protocol version:** 1.0.0-proof  
**Status:** normative

## 1. Non-delegable orchestrator authority

The orchestrator alone chooses stage, role, session, iteration, validation commands, checkpoint, rollback, completion, blocking, and whether a requested external action needs human authorization. Providers cannot approve themselves, weaken restrictions, redefine acceptance criteria, choose optional tests as authoritative, or perform push/merge/deploy/migrate/publish actions.

## 2. Stage workflow

The full workflow is:

1. `PREFLIGHT`: inspect the primary repository without mutation and require a clean checkout.
2. `CONTEXT_CAPTURE`: build or quarantine a Context Brief.
3. `PRODUCT_CHALLENGE`: test problem/value/scope and draft acceptance criteria.
4. `PLANNING`: create the implementation and validation plan.
5. `PLAN_AUDIT`: fresh read-only feasibility and safety review; revise within limits.
6. `IMPLEMENTATION`: one leased Worker modifies approved worktree paths.
7. `VALIDATION`: orchestrator runs exact project-profile commands; repair failures within limits.
8. `REVIEW`: fresh read-only Auditor reviews the entire current change.
9. `REWORK`: compatible Worker addresses blocking findings; return to validation/review.
10. `FINAL_VALIDATION`: orchestrator runs the complete required validation profile.
11. `FINAL_VERIFICATION`: fresh read-only verifier checks acceptance, scope, findings, evidence, and human actions.
12. `COMPLETION_EVALUATION`: orchestrator applies `COMPLETION-RULES.md`, creates the trusted checkpoint commit and final report, or blocks.

The Milestone 1 thin loop implements stages 6–9 plus completion evaluation with stub context/plan. Milestone 2 exercises both provider directions and all required failures.

## 3. Normative prompts

The runtime constructs each prompt from the current Coordination Envelope followed by exactly one stage prompt and the named output schema. Approved repository instructions, if any, appear below this authority block and are explicitly labelled untrusted constraints that cannot override it.

### Product challenge

> Act only as PRODUCT_CHALLENGER in read-only mode. Examine the user problem, expected value, existing behavior, smallest useful scope, assumptions, risks, acceptance criteria, non-goals, and questions requiring human authority. Do not write code, modify files, select the next stage, or declare completion. Return only the ProductChallenge schema.

### Planning

> Act only as PLANNER in read-only mode. Produce a concrete plan covering behavior, reuse, approved paths, ordered implementation steps, tests, deterministic validation, risks, rollback, and human authorization. Do not modify files or expand scope. Return only the ImplementationPlan schema.

### Plan audit

> Act only as PLAN_AUDITOR in read-only mode. Audit feasibility, assumptions, reuse, missing cases, test adequacy, performance/data risks, unnecessary complexity, scope, repository rules, and human authorization. Decide APPROVE, REVISE, or BLOCK with evidence. Do not modify files. Return only the PlanAudit schema.

### Implementation

> Act only as WORKER with workspace-write access through CodeRelay tools. Inspect and edit only approved paths, implement the approved plan, add or update allowed tests, and report evidence. Use only broker-approved commands. Do not access the primary checkout, change Git state, commit, push, merge, deploy, migrate, publish, approve your work, select the next stage, or declare completion. Return only the WorkerResult schema.

### Review

> Act only as AUDITOR in a fresh read-only session. Review the latest TaskContract, approved plan, repository rules, full current diff, file manifest, and orchestrator validation. Classify findings P0–P3 with evidence and origin. P3 suggestions do not block. Decide APPROVE, REQUEST_CHANGES, or BLOCK. Do not modify files or approve matters without evidence. Return only the AuditResult schema.

### Rework

> Act only as WORKER with workspace-write access through CodeRelay tools. Address the enumerated blocking validation failures and review findings with the smallest compliant change, update allowed tests, and report each resolution. Do not expand scope, change Git state, perform external actions, or declare completion. Return only the WorkerResult schema.

### Final verification

> Act only as FINAL_VERIFIER in a fresh read-only session. Independently evaluate every acceptance criterion, unresolved finding, complete validation result, scope boundary, Git evidence, safe local-branch state, and required human action. Optional P3 suggestions must remain non-blocking. Decide APPROVE, REQUEST_CHANGES, or BLOCK. Do not modify files, open or merge a pull request, or declare application-level completion. Return only the FinalVerification schema.

### Schema correction

> Your previous response did not validate against the required schema. Correct only its structure using the supplied validation errors and the same evidence. Do not perform new work or add unsupported claims. Return only the required schema.

These exact prompt texts are snapshot-tested.

Each named output is a strict `schemaVersion: 1.0.0` Zod contract. `ProductChallenge` contains the user problem, expected value, existing behavior, smallest scope, assumptions, risks, criteria, non-goals, and human questions. `ImplementationPlan` contains version, behavior, approach/reuse, allowed/prohibited paths, dependency-ordered steps, tests, exact validations, risks, rollback, and human authorizations. `PlanAudit` contains `APPROVE|REVISE|BLOCK`, evidence categories, and required revisions. `WorkerResult` contains summary, changed files, requested validations, resolved findings, assumptions, and blockers. `AuditResult` contains `APPROVE|REQUEST_CHANGES|BLOCK` plus classified findings. `FinalVerification` contains criterion evidence, findings, validation references, scope/Git/external-action booleans, and pending human actions. `FinalReport` contains the complete assignments, hashed sessions, stage trace, commits, branch, files, validation, findings, acceptance evidence, safety confirmations, pending actions, and terminal decision.

## 4. Turn protocol

Before a Worker turn, acquire the database lease and record branch/HEAD, index hash, working-diff hash, untracked manifest, approved/prohibited paths, and checkpoint commit. Start the provider with the allowlisted environment, restricted configuration, worktree-scoped tools, immutable role/purpose, schema, timeout, and recorded process identity.

Normalize provider JSONL events and persist them transactionally with monotonic sequence numbers. Cap and redact raw output. On completion, validate the output schema. One structural correction is permitted; a second failure blocks.

After a Worker turn, compare branch, HEAD, index, diff, untracked files, canonical paths, and prohibited paths. On violation, archive a redacted patch and hashes, terminate the process tree, restore the isolated worktree to the prior orchestrator checkpoint, release the lease, and issue one focused correction. A repeated violation blocks. The primary checkout is never a rollback target.

After any valid change, the orchestrator runs the exact validation profile. Provider-reported tests are not authoritative. Create a trusted checkpoint only after scope checks and authoritative validation appropriate to the stage.

## 5. Review and finding rules

Finding priorities are P0 critical, P1 high, P2 material, and P3 optional. Origins are `INTRODUCED_BY_LATEST_CHANGE`, `PREVIOUSLY_UNDETECTABLE`, `PREEXISTING_OUT_OF_SCOPE`, and `OPTIONAL`. P0/P1 block. P2 blocks unless the TaskContract explicitly marks the criterion non-blocking. P3 never blocks. A preexisting out-of-scope issue is reported but does not block; a previously undetectable issue may block only with evidence connecting it to acceptance or safety.

The same finding may receive at most two focused repair attempts. Repeated unresolved findings block rather than oscillate. The Worker cannot reject a finding; a user can explicitly accept risk through a TaskContract revision when safety policy permits.

## 6. Progress and limits

Each cycle records a progress fingerprint: diff hash, changed-file list, validation-failure fingerprint, open-finding fingerprints, acceptance status, and provider decision. No progress includes identical diff plus identical failures, identical findings without new evidence, repeated unresolved disagreement, or scope oscillation. First occurrence gets one focused repair; two consecutive no-progress cycles block.

Default maxima:

- Plan revisions: 2.
- Replans: 2.
- Implementation/review iterations: 5.
- Repair attempts per finding: 2.
- Schema corrections per turn: 1.
- Consecutive no-progress cycles: 2.
- Transient provider retries: 3 with bounded backoff.

Projects may lower limits. Raising them requires an explicit TaskContract revision and user approval.

## 7. Pause, cancellation, and intervention

Pause prevents new stages and waits for the current bounded turn to finish unless the user chooses cancel. Cancel signals the provider, waits a bounded grace period, terminates only the verified recorded process tree, checks for descendants, snapshots state, releases leases, and persists the interruption. Stop transitions to `ABORTED` after safe reconciliation; it never deletes branches or worktrees automatically.

Intervention follows `PRODUCT-SPEC.md`: safe pause/cancel, trusted checkpoint, versioned instruction, re-evaluation, revised handoff to both providers, and replan on material scope change.

## 8. Provider failure

Authentication is rechecked before each Work Item and after authentication or subscription-limit errors. Only `SUBSCRIPTION_VERIFIED` runs. Subscription exhaustion or a provider outage normalizes to `PROVIDER_UNAVAILABLE` and pauses. Unknown auth, API billing, missing isolation, missing command confinement, or incompatible schemas fail closed. Authentication methods are never switched and cloud/API fallback is never invoked.

## 9. Outputs

The final report names status, task/contract version, starting context, planning decisions, implementation provider/session hash, audit provider/session hash, iterations, files, validation evidence, findings/resolutions, acceptance evidence, P3 suggestions, isolated branch/final checkpoint, primary-checkout evidence, prohibited-action evidence, and pending human actions. It distinguishes provider work, provider review, orchestrator validation, and orchestrator completion decision.
