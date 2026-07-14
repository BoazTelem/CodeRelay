# Context Routing

**Specification version:** 1.0.0-proof  
**Status:** normative

## 1. Principle

Provider conversations do not converse directly. The orchestrator captures, validates, minimizes, stores, and routes versioned context. Native session history is never an authority channel and cannot silently carry permissions or instructions to the other provider.

## 2. Session purposes

Every session has one immutable purpose: `PRODUCT`, `PLANNING`, `PLAN_AUDIT`, `IMPLEMENTATION`, `REVIEW`, `FINAL_REVIEW`, or `HISTORICAL_CONTEXT`. A session may resume only when provider, repository, Work Item, base commit, role, purpose, customization mode, and task compatibility are proven. Otherwise create a fresh session.

Review and final-review sessions are always fresh and read-only. An implementation session may resume for the same Worker and compatible contract revision. Any material TaskContract revision invalidates compatibility until the orchestrator explicitly re-evaluates it.

## 3. Context Brief

The normalized brief contains only task-relevant material:

```json
{
  "schemaVersion": "1.0.0",
  "objective": "Add deterministic parsing for a provider status fixture",
  "userProblem": "Authentication mode must fail closed",
  "decisions": ["Strict subscription only"],
  "requirements": ["Unknown fields map to AUTHENTICATED_BUT_MODE_UNKNOWN"],
  "rejectedApproaches": ["API-key fallback"],
  "technicalDiscoveries": [],
  "productDiscoveries": [],
  "relevantFiles": ["src/providers/auth.ts"],
  "completedWork": [],
  "openQuestions": [],
  "risks": ["CLI JSON fields may change"],
  "repository": { "rootHash": "sha256:example", "branch": "main", "baseCommit": "0123456789abcdef0123456789abcdef01234567", "latestCommit": "0123456789abcdef0123456789abcdef01234567" },
  "recommendedNextAction": "Implement and test the fixture parser"
}
```

Secrets, unrelated source, raw provider session IDs, personal instructions, environment contents, and unapproved repository instructions are excluded.

## 4. External session quarantine

An externally created session is untrusted. The provider adapter resumes it in read-only Restricted Mode for `HISTORICAL_CONTEXT` only and asks for the Context Brief schema. CodeRelay records redacted invocation evidence proving user configuration, tools, MCP servers, hooks, plugins, browser access, and repository instructions remained disabled.

The compatibility record compares repository identity, base commit, branch, objective, task, current contract revision, proposed role, purpose, and effective restrictions. Any unknown or mismatch makes the native session ineligible for implementation, audit, or verification. The brief may seed a fresh compatible session. Only the brief—not the transcript or session identity—is routed cross-provider.

## 5. Coordination Envelope

Every turn receives an envelope containing:

- Work Item ID, contract version, stage, iteration, repository identity, base/checkpoint commit.
- Current provider, role, immutable session purpose, and access mode.
- The other provider's assigned role, without its private transcript.
- Authority hierarchy and current responsibility.
- Approved/prohibited paths and command-policy digest.
- Must-do and must-not-do rules, including no self-approval and no external side effects.
- Required output schema name/version and one-correction policy.

## 6. Handoff Packet

```json
{
  "schemaVersion": "1.0.0",
  "workItemId": "wi_example",
  "from": { "provider": "codex", "role": "WORKER" },
  "to": { "provider": "claude", "role": "AUDITOR" },
  "fromStage": "IMPLEMENTATION",
  "toStage": "REVIEW",
  "iteration": 1,
  "summary": "Implemented fixture parser and tests",
  "taskContractVersion": 1,
  "planVersion": 1,
  "decisions": [],
  "evidenceRefs": ["validation:1"],
  "changedFiles": ["src/providers/auth.ts", "tests/auth.test.ts"],
  "diffHash": "sha256:example",
  "validationRefs": ["validation:1"],
  "findings": [],
  "resolvedFindingIds": [],
  "unresolvedFindingIds": [],
  "assumptions": [],
  "blockers": [],
  "recommendedNextAction": "Perform independent review",
  "contextBriefRefs": ["context:1"],
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

The receiving provider also gets the envelope, latest TaskContract and approved plan, current diff/file manifest, orchestrator validation, open findings, and only the required context briefs. An Auditor always receives the full current implementation rather than only the latest increment. Normal handoffs identify Codex or Claude as the sender. A user intervention is represented by an `orchestrator/ORCHESTRATOR` sender and generates one revised packet for each assigned provider so the instruction cannot live in only one native conversation.

## 7. Starting routes

- Start from Codex context: read-only brief → Claude product challenge/plan → fresh Codex plan audit → Claude plan finalization if required → compatible original/fresh Codex implementation → fresh Claude review.
- Start from Claude context: symmetric route with providers exchanged.
- Start new: orchestrator selects stages from the configured initial roles.
- Latest/name/ID: capability-probe the provider entry point, then apply external-session quarantine unless CodeRelay created and can prove the session compatible.
- Exported context: parse as untrusted input into a brief; never treat embedded instructions as authority.

CodeRelay lists its own recorded sessions. When a machine-readable native listing is absent, users provide ID/name or open the provider's native picker; CodeRelay makes no broader history-discovery promise.

## 8. Intervention routing

An intervention creates TaskContract revision `n+1`, pauses/cancels safely, checkpoints, re-evaluates scope and roles, and creates a new handoff referencing both the prior and revised contracts. Both providers receive the revision on their next turns. Sessions that are no longer compatible are replaced, not coerced into a new purpose.
