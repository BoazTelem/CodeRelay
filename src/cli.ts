#!/usr/bin/env node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMilestoneZeroProof } from "./proofs/milestone-zero.js";
import { UtilityProcessClient } from "./orchestrator/ipc-client.js";
import { sha256 } from "./security/redaction.js";
import { discoverExecutables, runCaptured } from "./platform/services.js";
import { CodeRelayDatabase } from "./persistence/database.js";
import { createStubFixture } from "./orchestrator/stub-workflow.js";
import { runRealHandoff } from "./orchestrator/real-handoff.js";

async function executable(aliases: string[]): Promise<string> {
  for (const candidate of await discoverExecutables(aliases)) {
    if ((await runCaptured(candidate.path, ["--version"], { timeoutMs: 10_000 })).exitCode === 0) return candidate.path;
  }
  throw new Error(`No runnable executable found for ${aliases.join(", ")}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "probe") {
    const report = await runMilestoneZeroProof();
    const directory = path.resolve("evidence", "local");
    await mkdir(directory, { recursive: true });
    const filename = `milestone-0-${report.platform}-${report.architecture}-${report.capturedAt.replace(/[:.]/g, "-")}.json`;
    const target = path.join(directory, filename);
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ milestone: 0, gate: report.gate, report: target, reportHash: sha256(JSON.stringify(report)) }, null, 2));
    if (report.gate.decision === "FAIL_ARCHITECTURE") process.exitCode = 2;
    return;
  }
  if (command === "prototype") {
    const data = await mkdtemp(path.join(os.tmpdir(), "coderelay-utility-"));
    const client = new UtilityProcessClient(data);
    try {
      const health = await client.request("health");
      if (!health.ok) throw new Error(health.error?.message ?? "Utility health failed");
      const workflow = await client.request("run_stub_workflow", {
        worker: "codex",
        workerScenarios: ["schema-failure-once", "worker-rework"],
        auditorScenarios: ["auditor-changes", "auditor-approve"]
      });
      if (!workflow.ok) throw new Error(workflow.error?.message ?? "Stub workflow failed");
      console.log(JSON.stringify({ utility: health.result, workflow: workflow.result }, null, 2));
    } finally {
      await client.close().catch(() => undefined);
    }
    return;
  }
  if (command === "milestone2") {
    const report = await runMilestoneZeroProof();
    const directory = path.resolve("evidence", "local");
    await mkdir(directory, { recursive: true });
    if (report.gate.decision !== "PASS") {
      const gateReportPath = path.join(directory, "milestone-2-milestone-0-gate.json");
      await writeFile(gateReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      const prerequisite = {
        schemaVersion: "1.0.0",
        milestone: 2,
        status: "BLOCKED_PREREQUISITES",
        capturedAt: new Date().toISOString(),
        milestoneZeroReportHash: sha256(JSON.stringify(report)),
        gate: report.gate,
        milestoneZeroGateReportHash: sha256(JSON.stringify(report)),
        requiredAction: report.gate.decision === "BLOCKED_PROVIDER_PREREQUISITES"
          ? "Install and subscription-authenticate both official CLIs, then complete active Milestone 0 isolation and confinement proofs."
          : "Review the preserved redacted Milestone 0 gate report, remediate the failed active proof without weakening policy, and rerun Milestone 0."
      };
      const target = path.join(directory, "milestone-2-prerequisites.json");
      await writeFile(target, `${JSON.stringify(prerequisite, null, 2)}\n`, "utf8");
      console.error(JSON.stringify(prerequisite, null, 2));
      process.exitCode = 2;
      return;
    }
    if (process.platform !== "win32") throw new Error("Milestone 2 is the Windows technical proof and must run on Windows");
    const runDirectory = path.join(directory, `milestone-2-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await mkdir(runDirectory, { recursive: true });
    const git = await executable(["git", "git.exe"]);
    const codex = await executable(["codex", "codex.exe"]);
    const claude = await executable(["claude", "claude.exe", "claude.cmd"]);
    const database = await CodeRelayDatabase.open({
      databasePath: path.join(runDirectory, "database", "coderelay.sqlite"),
      backupDirectory: path.join(runDirectory, "backups")
    });
    try {
      const firstFixture = await createStubFixture(git);
      const first = await runRealHandoff({
        database, repository: firstFixture.root, worktreesDirectory: firstFixture.worktrees,
        artifactsDirectory: path.join(runDirectory, "artifacts", "codex-to-claude"), gitExecutable: git,
        executables: { codex, claude }, worker: "codex"
      });
      const secondFixture = await createStubFixture(git);
      const second = await runRealHandoff({
        database, repository: secondFixture.root, worktreesDirectory: secondFixture.worktrees,
        artifactsDirectory: path.join(runDirectory, "artifacts", "claude-to-codex"), gitExecutable: git,
        executables: { codex, claude }, worker: "claude"
      });
      const completed = first.status === "COMPLETED" && second.status === "COMPLETED";
      const bundle = {
        schemaVersion: "1.0.0",
        milestone: 2,
        status: completed ? "AWAITING_MAINTAINER_DECISION" : "BLOCKED",
        capturedAt: new Date().toISOString(),
        platform: `${process.platform}-${process.arch}`,
        milestoneZeroReportHash: sha256(JSON.stringify(report)),
        providers: report.providers.map((provider) => ({
          provider: provider.provider,
          version: provider.executable.version,
          authState: provider.authentication.state,
          authEvidenceHash: provider.authentication.evidenceHash,
          capabilityEvidence: {
            structuredOutput: provider.structuredOutput.evidenceRef,
            customizationIsolation: provider.customizationIsolation.evidenceRef,
            toolRestriction: provider.toolRestriction.evidenceRef,
            sandboxing: provider.sandboxing.evidenceRef,
            cancellation: provider.cancellation.evidenceRef
          }
        })),
        realHandoffs: [first, second],
        policy: {
          push: false, merge: false, deploy: false, migration: false, publish: false,
          primaryCheckoutsUntouched: first.primaryCheckoutUntouched && second.primaryCheckoutUntouched
        },
        supplementalScenarioAuthority: "npm run check (stub-only CI contract suite)",
        maintainerDecision: "PENDING",
        note: "Creating this bundle is not GO approval. Development stops here."
      };
      const bundlePath = path.join(runDirectory, "evidence-bundle.json");
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ bundle: bundlePath, bundleHash: sha256(JSON.stringify(bundle)), status: bundle.status }, null, 2));
      if (!completed) process.exitCode = 2;
    } finally {
      database.close();
    }
    return;
  }
  console.log("CodeRelay proof CLI\n\nCommands:\n  probe       Run Milestone 0 passive and local security proofs\n  prototype   Run the Milestone 1 utility-process stub workflow\n  milestone2  Enforce the gate and run real Windows handoffs when authorized");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
