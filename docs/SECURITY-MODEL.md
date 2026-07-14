# Security Model

**Model version:** 1.0.0-proof  
**Status:** normative

## 1. Assets and trust boundaries

Protected assets are user source repositories, Git state, local files outside an isolated worktree, provider authentication, environment secrets, subscription usage, workflow authority, validation evidence, and external/production systems.

Untrusted inputs include user-selected repository content, repository instruction files, provider output, external session history, package scripts, symlinks/junctions/reparse points, project profiles, CLI status output, child processes, and artifacts imported from another machine.

The renderer, future preload, Electron main, utility, provider process, MCP bridge, isolated worktree, primary checkout, SQLite database, and operating system are separate trust boundaries. Only the utility owns workflow authority. Provider processes are treated as potentially confused agents, not security principals.

## 2. Strict subscription authentication

V1 mode is only `strict-subscription-only`. Immediately before Work Item creation, and after any auth/subscription error, adapters invoke the official local status commands and normalize evidence:

- Codex: `codex login status` plus version and capability probes.
- Claude: `claude auth status` JSON plus version and capability probes.

Only `SUBSCRIPTION_VERIFIED` proceeds. Explicit API/Console billing maps to `API_BILLING_DETECTED`; authenticated but unrecognized output maps to `AUTHENTICATED_BUT_MODE_UNKNOWN`; absence maps to `NOT_AUTHENTICATED`; missing/incompatible/exhausted provider maps to `PROVIDER_UNAVAILABLE`. Unknown fails closed. Parser fixtures retain redacted stdout/stderr, exit status, version, and observed field names because formats can change.

CodeRelay never stores provider credentials, switches authentication, invokes cloud-task modes, uses Claude `--cloud`, or falls back to API calls.

## 3. Environment construction

Provider environments are built from a small OS-specific allowlist needed for execution and locale (for example `SystemRoot`, `WINDIR`, approved restricted `PATH`, `TEMP`, `TMP`, `HOME`/profile location only when required, and deterministic locale fields). Values are recorded only as names and hashes.

Always omit names matching API keys, tokens, authorization, alternate base URLs, proxies unless explicitly required and proven safe, cloud-provider selectors/credentials, CI secrets, SSH agents, Git credentials, browser profiles, unrelated application variables, and project-configured secret patterns. Never inherit the desktop environment wholesale.

## 4. Customization modes

`restricted` is default. It disables personal instructions, automatic repository instructions, hooks, plugins, custom agents, browser/web tools, unknown MCP servers, and direct shell/filesystem mutation. Codex is invoked with ignored user configuration, suppressed project docs, disabled shell/unified-exec/web features, a read-only provider sandbox, and only the CodeRelay MCP broker when capability proofs support each flag. The Worker's logical `workspace-write` authority belongs to that broker, not the Codex process. Codex auto-approves only that short-lived broker because the broker independently enforces paths and commands; no other MCP server is loaded.

Claude uses two proven Restricted Mode profiles. Tool-free read-only turns use `--safe-mode`. Worker turns cannot use `--safe-mode` because Claude 2.1.209 suppresses even an explicitly supplied MCP server under that flag. Instead they load no user/project/local setting sources, use strict explicit MCP configuration, disable slash commands, Chrome, and all built-in tools, and allow only the five Work-Item-scoped CodeRelay MCP tools. The Milestone 0 adversarial marker, hook-event, available-tool, broker-write, and outside-worktree proofs must all pass before this capability-dependent profile is accepted.

`inherit-user-configuration` may reintroduce personal instructions and separately approved read-only extensions with a warning, but cannot reintroduce mutating/unknown tools or relax hard policies. It is outside strict proof execution unless specifically tested.

Repository instructions are displayed by canonical path and SHA-256. Approval is per project and hash; a change invalidates approval. Approved text is inserted below CodeRelay authority and treated as untrusted constraints. Repository content can never override roles, tools, paths, completion, or external-action restrictions.

Milestone 0 adversarially proves that user/repository configuration cannot load a marker instruction or unauthorized tool. Failure blocks the architecture.

## 5. Filesystem confinement

The app-owned bridge exposes only `read_file`, `list_files`, `search`, `apply_patch`, and `run_command` with a short-lived Work-Item capability. Each path is resolved from the isolated worktree; absolute paths, traversal, alternate data streams, device paths, UNC escape, case aliases, and `.git` are rejected as applicable.

Before access, canonicalize the existing parent, inspect each component without following an unapproved symlink/junction/reparse point, then verify the final canonical path is inside an approved root and outside every prohibited root. Recheck immediately before atomic write to reduce time-of-check/time-of-use risk. Provider read/write access outside the isolated worktree is never granted.

`apply_patch` accepts structured edits, validates every affected path, limits bytes/files, rejects binary changes unless explicitly approved, writes atomically where supported, and returns content hashes. It never accepts a shell patch command.

## 6. Command broker

`run_command` accepts `{executable, args[], cwd, timeoutMs}` and never shell text. It resolves an approved executable identity, rejects shell metacharacter interpretation by spawning without a shell, verifies `cwd` confinement, uses the allowlisted environment, limits time/output, and terminates the verified process tree on cancellation.

The policy is default-deny. Allowed commands are exact read-only Git operations, exact plan-approved commands, and exact project validation commands. Immutable denials include:

- `git commit`, `push`, `merge`, `rebase`, `reset`, `clean` (including aliases, absolute executable paths, `-c alias.*`, and argument rearrangements).
- `gh pr merge`.
- all `gcloud` and `supabase` commands.
- `terraform apply` and equivalent apply-plan invocation.
- `kubectl apply`.
- `npm publish`, `pnpm publish`, and aliases that delegate to them.

Projects can add denials but cannot remove these. Executable hashes/real paths and argument parsers prevent basename or wrapper bypass. A restricted `PATH` containing CodeRelay wrappers is defense in depth; the authoritative decision remains the broker. Only the utility has the separately resolved trusted Git executable for checkpoint commits.

## 7. Git scope enforcement

Preflight never mutates the primary checkout. A provider receives only an isolated worktree. Before/after each Worker turn, record branch, HEAD, index, canonical diff, untracked manifest, and allowed/prohibited paths. Reject unexpected Git-state or path changes, archive a redacted violation patch/hashes, stop descendants, and restore only the isolated worktree to the prior trusted checkpoint. One correction is allowed; repetition blocks. A transactional Worker lease prevents concurrent writers.

## 8. Process security

Record provider executable real path/hash, PID, creation time or OS process-start identifier, parent/child relationships, Work Item, and capability nonce. Cancellation first requests graceful stop, then uses OS-specific tree termination only after identity verification. PID alone is insufficient because of reuse. Startup terminates an orphan only when executable, start identity, parent/nonce evidence, and Work Item record match; otherwise pause for human review.

## 9. Persistence, logs, and privacy

SQLite uses foreign keys, WAL, transactional migrations, verified pre-migration backups, three-backup retention, startup `quick_check`, and maintenance `integrity_check`. Corruption quarantines and stops. Windows config uses `%APPDATA%\CodeRelay`; database/logs/artifacts/backups/worktrees use `%LOCALAPPDATA%\CodeRelay`; macOS later uses `~/Library/Application Support/CodeRelay`.

Logs redact tokens, authorization headers, configured secrets, omitted environment values, raw session IDs, and sensitive paths when evidence can use hashes. Raw turns cap at 20 MiB; application logs rotate five 10 MiB files. No telemetry or crash upload occurs by default.

## 10. Required adversarial proofs

Tests cover banned-command casing/aliases/absolute paths/nested shells, environment exfiltration, executable substitution, traversal, symlink/junction/reparse escapes, `.git`, outside-worktree reads/writes, race checks where feasible, primary-checkout preservation, user/repository instruction injection, inherited MCP/plugin/hook/browser settings, schema confusion, session-purpose reuse, cancellation descendants, crash reconciliation, violation rollback, and provider-unavailable/auth-unknown fail-closed behavior.

If either real provider cannot prove strict subscription state, customization isolation, broker-only command access, or worktree confinement, Milestone 0 fails and implementation stops for architecture revision.
