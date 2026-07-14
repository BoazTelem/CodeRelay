# Milestone 2 Windows Handoff Procedure

`npm run milestone2` first reruns the complete active Milestone 0 gate. It refuses to start if either executable is unavailable, either auth state is not `SUBSCRIPTION_VERIFIED`, or active schema/isolation/broker/confinement/cancellation evidence is incomplete.

After a passing gate, it creates two disposable clean repositories and runs:

1. A real Codex Worker through the scoped CodeRelay MCP broker, authoritative validation and trusted checkpoint, then a fresh tool-free Claude Auditor.
2. A different real Claude Worker fixture through the same policy layer, authoritative validation and trusted checkpoint, then a fresh tool-free Codex Auditor.

Auditor change requests return to the compatible Worker for at most three iterations. Provider sessions, schemas, role assignments, leases, checkpoints, handoffs, decisions, and validation hashes persist in the proof SQLite database. Evidence stores only hashed session identifiers. Each primary fixture checkout is compared before/after. Any unexpected path, Git-state change, non-CodeRelay tool, missing fresh review, auth change, validation failure at the limit, or policy breach blocks.

The resulting redacted `evidence-bundle.json` records `AWAITING_MAINTAINER_DECISION`. It confirms that no push, merge, deploy, migration, or publish operation was performed. The process then stops. Only an explicit update of `docs/decisions/MILESTONE-2.md` after human review can record `GO`, `CONDITIONAL_GO`, or `NO_GO`.

