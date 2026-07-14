# CodeRelay Product Specification

**Specification version:** 1.0.0-proof  
**Status:** normative  
**Execution authority:** Milestones 0–2 only

## 1. Purpose

CodeRelay coordinates separately installed, subscription-authenticated Codex and Claude Code CLIs so one provider can perform implementation work while a separately scoped provider reviews it. It transfers structured context, enforces repository and command boundaries, runs authoritative validation, persists recoverable state, and produces an evidence-backed local branch and report without automatically pushing, merging, deploying, migrating, publishing, or opening a pull request.

CodeRelay is an independent open-source project and is not affiliated with, endorsed by, or sponsored by OpenAI or Anthropic.

CodeRelay does not bundle Codex or Claude Code. Users install and authenticate the official command-line tools separately.

## 2. Authority and normative sources

These repository documents are the complete implementation authority. The source PDFs are historical Milestone 0 inputs and are not required by contributors or the running application.

Authority descends in this order:

1. Current explicit user instructions recorded in the latest `TaskContract` revision.
2. The CodeRelay orchestrator and this repository-owned specification.
3. Explicitly approved repository instructions and deterministic validation results.
4. The currently assigned provider role.

Lower authorities cannot relax higher-level safety policy, choose their own role or next stage, approve their own work, declare the Work Item complete, or authorize external side effects.

## 3. Authorized execution boundary

The Windows technical proof phase contains only:

- Milestone 0: executable, provider, authentication, session, isolation, command, filesystem, process, and failure proofs.
- Milestone 1: console-only orchestration utility, validated IPC test client, SQLite persistence, stubs, and the minimal autonomous loop.
- Milestone 2: a real Windows Codex Worker → fresh Claude Auditor handoff and a different Claude Worker → fresh Codex Auditor handoff, followed by a redacted evidence bundle.

After Milestone 2, all development stops. A maintainer records `GO`, `CONDITIONAL_GO`, or `NO_GO`. Evidence creation is not approval. Before `GO`, the project must not implement the polished React/Electron UI, macOS runtime support, packaging, signing, notarization, automatic updates, or releases.

## 4. Complete V1 scope

A later V1 requires Windows x64, macOS Intel, and macOS Apple Silicon production support with functionally equivalent project selection, preflight, role configuration, context routing, orchestration, intervention, persistence, security, and reports. Separate Intel and Apple Silicon installers are acceptable if a universal build is unsafe or delayed. Windows ARM64, Linux, MSI/MSIX, Mac App Store distribution, private feeds, cross-device sync, automatic PR creation, merging, deployment, migration, and installed-version rollback are outside V1.

V1 is complete only when a user can:

- Install and use CodeRelay on Windows x64 and on either supported Mac architecture.
- Verify subscription authentication for both providers and select a clean repository.
- Start a new provider session, resume by supported ID/name/latest entry point, paste exported context, or open the native picker.
- Derive safe context from an external session without inheriting its permissions or assumptions.
- Assign Worker and Auditor roles using fixed, both-capable, alternating, or manual routing.
- Enter a coding task and observe automatic structured handoffs, validation, review, rework, and blockers.
- Pause, resume, stop, intervene, and safely override future roles.
- Receive a committed isolated local branch, complete report, and evidence that the primary checkout was untouched and no prohibited external action occurred.

## 5. Four-layer architecture

```text
React renderer (presentation and user input)
    |
Validated preload IPC layer (narrow Zod-validated API)
    |
Electron main process (desktop lifecycle and utility supervision)
    |
Separate orchestration utility process (state and execution authority)
```

Electron main owns windows, menus, dialogs, application lifecycle, updater lifecycle, and supervision only. It must not directly own SQLite, Git operations, or long-running provider processes. The orchestration utility owns SQLite, workflow state, provider processes, isolated Git worktrees, validation, cancellation, command and filesystem enforcement, artifacts, and recovery.

Requests and events are versioned and schema-validated, with correlation IDs and idempotency keys. Renderer reloads must not interrupt active orchestration. On a full crash, the next utility launch reconciles database state, Git checkpoints, worktrees, and recorded process identity before resuming; ambiguity pauses the Work Item.

Electron security requirements for later UI work are `nodeIntegration: false`, `contextIsolation: true`, a strict preload API, content security policy, no remote content with application privileges, and validation on both IPC ends.

## 6. Public contract inventory

Every persisted or IPC-visible contract has a semantic schema version and a Zod schema:

- `ProviderAuthState`: `SUBSCRIPTION_VERIFIED`, `API_BILLING_DETECTED`, `AUTHENTICATED_BUT_MODE_UNKNOWN`, `NOT_AUTHENTICATED`, or `PROVIDER_UNAVAILABLE`.
- `ProviderCapabilities`: provider/version, executable proof, authentication probe, structured output, resume modes, customization isolation, tool restriction, sandboxing, process control, and known incompatibilities.
- `CustomizationMode`: `restricted` or `inherit-user-configuration`.
- `CommandPolicy`: executable/argument allow rules, immutable hard denials, project additions, approved paths, and prohibited paths.
- `PlatformServices`: executable discovery, application paths, shell metadata, permissions, canonical-path inspection, and process-tree termination.
- `ProviderAdapter`: capability probe, authentication normalization, new/resumed turn, event normalization, cancellation, and schema validation.
- `TaskContract`, `ContextBrief`, `RoleConfiguration`, `RoleAssignment`, `CoordinationEnvelope`, `HandoffPacket`, `ValidationResult`, `Finding`, `GitCheckpoint`, `WorkItem`, utility request/event, and final report.

Documentation contains canonical schema examples. Tests parse those examples and snapshot the normative prompts.

## 7. Core functional behavior

The orchestrator captures context, challenges the product request, creates and audits a plan, implements within an isolated worktree, runs deterministic validation, obtains a fresh independent review, routes rework, performs full final validation and fresh final verification, and alone evaluates completion.

Default assignment is Codex Worker and Claude Auditor. Exactly one Worker lease may exist per Work Item. An Auditor and Final Verifier are read-only and cannot share the implementation session they review. Roles and sessions are persisted before every stage.

Only orchestrator-run validation is authoritative. Provider claims are commentary until matched by recorded command output. The provider output must match the stage schema; one focused schema-correction turn is allowed, then the Work Item blocks.

## 8. Session promises

Supported entry points are new session, exact session ID, session name when probed, latest repository session, pasted exported context, and the native CLI picker. CodeRelay reliably lists sessions it created. It does not promise to enumerate all external historical sessions.

External sessions are untrusted. They first run read-only in Restricted Mode solely to extract a `ContextBrief` and compatibility evidence. If repository, base/branch, objective/task, purpose/role, or customization isolation cannot be proven compatible, the native session cannot implement, audit, or verify; a fresh role-specific session receives only the brief. A prior Worker session can never become an independent Auditor or Final Verifier.

## 9. Repository safety

Before Work Item creation, read-only preflight records canonical root, remotes and selected remote, current branch/HEAD/default branch, modified/deleted tracked files, staged files, nonignored untracked files, unpushed commits, worktrees, CodeRelay branch/worktree metadata, submodules, and Git LFS state where applicable.

The primary checkout must be clean, including submodules. Unpushed commits require a displayed warning and explicit confirmation. Preflight never fetches, downloads LFS objects, updates submodules, or cleans, resets, stashes, restores, checks out, rebases, or otherwise alters the primary checkout. The isolated branch/worktree starts at the recorded commit. Matching existing CodeRelay state offers resume; naming collisions never delete or reuse unrelated state.

## 10. Privacy and data lifecycle

Defaults are no telemetry, no crash upload without opt-in, no CodeRelay-owned credentials, 90-day completed Work Item retention, 30-day raw provider-log retention, exemption for active/pinned items, immediate user deletion, 20 MiB raw-turn cap with truncation marker, and five rotating 10 MiB application logs. Tokens, authorization headers, configured secrets, omitted environment variables, and raw session identifiers are redacted or hashed in evidence.

The application clearly warns that prompts and relevant source code are sent through authenticated Codex and Claude services. Work Items can be exported as versioned JSON plus evidence, reports, and redacted artifacts. Deleting CodeRelay data is separate from deleting provider sessions or Git branches.

## 11. Human intervention

Every intervention produces a new `TaskContract` revision. The utility pauses safely, finishes or cancels the active turn, creates an orchestrator checkpoint, stores the instruction and provenance, re-evaluates acceptance criteria/scope/paths/tests/risks/roles/human authorizations, creates a revised handoff, sends the revision to both providers on their next turns, and replans when scope materially changes. An instruction may never exist only in one provider conversation.

## 12. Milestone 2 approval gate

Maintainers must review subscription evidence, restricted configuration, command escape and filesystem confinement tests, preflight, external-session isolation, role/session isolation, schema correction, cancellation/process termination, crash reconciliation, scope rollback, validation authority, and confirmation of no push/merge/deploy/migrate/publish action.

- `GO` authorizes later UI and cross-platform work.
- `CONDITIONAL_GO` authorizes only named remediation and repetition of affected proofs.
- `NO_GO` requires an architecture revision.

A decision is valid only when recorded with decision, reviewer, timestamp, evidence-bundle hash, rationale, and any conditions.

