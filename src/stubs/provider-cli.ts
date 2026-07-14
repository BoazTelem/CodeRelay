#!/usr/bin/env node
import { randomUUID } from "node:crypto";

type Scenario =
  | "worker-success"
  | "worker-rework"
  | "auditor-approve"
  | "auditor-changes"
  | "schema-failure-once"
  | "timeout"
  | "subscription-failure"
  | "prohibited-command"
  | "prohibited-path"
  | "crash";

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function main(): Promise<void> {
  const scenario = (option("--scenario", "worker-success") ?? "worker-success") as Scenario;
  const provider = option("--provider", "stub-codex")!;
  const correction = process.argv.includes("--correction");
  const sessionId = option("--session-id") ?? randomUUID();
  emit({ type: "session.started", provider, sessionId, fresh: !option("--session-id") });
  emit({ type: "turn.started", scenario });

  if (scenario === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return;
  }
  if (scenario === "subscription-failure") {
    emit({ type: "error", code: "subscription_exhausted", message: "Stub subscription limit reached" });
    process.exitCode = 42;
    return;
  }
  if (scenario === "crash") {
    emit({ type: "error", code: "simulated_crash" });
    process.exitCode = 44;
    return;
  }
  if (scenario === "prohibited-command") {
    emit({ type: "tool.call", id: randomUUID(), tool: "run_command", arguments: { executable: "git", args: ["push"], cwd: ".", timeoutMs: 5_000 } });
  }
  if (scenario === "prohibited-path") {
    emit({ type: "tool.call", id: randomUUID(), tool: "apply_patch", arguments: { edits: [{ path: "../outside.txt", content: "violation\n" }] } });
  }
  if (scenario === "worker-success" || scenario === "schema-failure-once") {
    emit({ type: "tool.call", id: randomUUID(), tool: "apply_patch", arguments: { edits: [{ path: "src/result.txt", content: "implemented\n" }] } });
  }
  if (scenario === "worker-rework") {
    emit({ type: "tool.call", id: randomUUID(), tool: "apply_patch", arguments: { edits: [{ path: "src/result.txt", content: "implemented and audited\n" }] } });
  }

  if (scenario === "schema-failure-once" && !correction) {
    emit({ type: "turn.completed", output: { invalid: true } });
    return;
  }
  if (scenario.startsWith("worker") || scenario === "schema-failure-once" || scenario.startsWith("prohibited")) {
    emit({ type: "turn.completed", output: {
      schemaVersion: "1.0.0",
      summary: scenario === "worker-rework" ? "Addressed the requested audit change" : "Implemented the approved fixture change",
      changedFiles: ["src/result.txt"],
      testsRequested: ["node validate.mjs"],
      resolvedFindingIds: scenario === "worker-rework" ? ["finding_fixture"] : [],
      assumptions: [],
      blockers: []
    } });
    return;
  }
  if (scenario === "auditor-changes") {
    emit({ type: "turn.completed", output: {
      schemaVersion: "1.0.0",
      decision: "REQUEST_CHANGES",
      summary: "The fixture needs the audited marker",
      findings: [{
        id: "finding_fixture", priority: "P2", origin: "INTRODUCED_BY_LATEST_CHANGE",
        title: "Audited marker missing", evidence: "src/result.txt does not contain audited", blocking: true, status: "open"
      }]
    } });
    return;
  }
  emit({ type: "turn.completed", output: { schemaVersion: "1.0.0", decision: "APPROVE", summary: "The complete fixture diff and validation evidence satisfy the contract", findings: [] } });
}

main().catch((error: unknown) => {
  emit({ type: "error", code: "stub_exception", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

