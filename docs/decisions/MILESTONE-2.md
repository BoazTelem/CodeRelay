# Milestone 2 Maintainer Decision

Decision: CONDITIONAL_GO

Evidence bundle: `evidence/local/milestone-2-2026-07-17T06-52-32-628Z/evidence-bundle.json`  
Evidence bundle artifact SHA-256: `sha256:7561f52abfed8a895cd05c1b32327e21dcdf3b1738b9ffd8f006ad495cd224f8`  
Canonical bundle payload hash: `sha256:1536aee63690fc959bd361bad824f253261985bf7bf1816d1e52e0a91ed40c55`  
Milestone 0 gate report: `evidence/local/milestone-0-win32-x64-2026-07-17T06-50-32-835Z.json` (canonical payload hash `sha256:5e5dc115918ce1af52911daa24009a972c9f05472cf887f002df1b13053fbeb6`, gate `PASS`)  
Reviewer: Boaz Telem (btelem, maintainer)  
Reviewed at: 2026-07-17  
Rationale: Milestone 0 passed with both real providers subscription-verified (`codex-cli 0.144.4`, Claude Code `2.1.209`); both real Windows handoff directions completed in one iteration each with broker-only access, Git checkpoints, untouched primary checkouts, and no prohibited external actions. Reported hashes were independently recomputed and reproduced; per-handoff artifacts are schema-conformant and mutually consistent; the bundled SQLite database passes `PRAGMA integrity_check` with row counts matching the bundle. Decision recorded by the maintainer in session on 2026-07-17.

Conditions (must be resolved before any release or packaging work; other post-GO development may proceed):

1. AUD-M2-001 — the fixture validator (`validate.mjs`) must emit a one-line pass summary so the recorded validation output hash is non-trivial (the recorded hash was the SHA-256 of a single newline).
2. `milestone2` must persist the internally re-run Milestone 0 report to disk on PASS (not only on failure) so the bundle's `milestoneZeroReportHash` is independently verifiable.
3. Broker configuration artifacts copied into the evidence bundle must be redacted (raw local filesystem paths and the local username appear in `*.broker.json`); the live broker config may keep raw paths, but the bundled artifact copy must not.

## Conditions resolution (2026-07-17)

All three conditions were implemented and verified the same day:

1. The fixture validator now emits `VALIDATION PASS`/`VALIDATION FAIL` lines; recorded validation output hashes are non-trivial.
2. `milestone2` persists the internally re-run Milestone 0 report as `milestone-0-gate-report.json` in the run directory on PASS, and the bundle names it via `milestoneZeroReportFile`; the file's canonical payload hash matches the bundle's `milestoneZeroReportHash`.
3. Live broker and MCP launch configurations moved to private runtime temp directories; the bundled artifact copies carry SHA-256 hashes in place of absolute paths and `[REDACTED_NONCE]` in place of the capability nonce. Additionally, provider-facing prompts now render validation executables by basename only, so provider outputs can no longer echo raw local paths.

Verification bundle demonstrating the resolved conditions: `evidence/local/milestone-2-2026-07-17T07-33-11-767Z/evidence-bundle.json` (canonical payload hash `sha256:944795404d64a68873c6e15e2c8bf5b6631c5ce3d6dcd528e84438d04926e9e3`). Both directions `COMPLETED`; an automated artifact scan found no raw local paths or usernames. One non-blocking `accepted-risk` auditor note remains (the tool-restricted audit session verifies from orchestrator-attested evidence by design). Typecheck and the 43-test suite pass.

Allowed recorded decisions are exactly `GO`, `CONDITIONAL_GO`, or `NO_GO`. Changing this record requires explicit maintainer review of every gate item in `PRODUCT-SPEC.md`.
