import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { AuthenticationProof, ProviderCapabilities, SCHEMA_VERSION, type ProviderName } from "../contracts/schemas.js";
import type { ProviderAdapter, ProviderTurnRequest, ProviderTurnResult } from "./types.js";
import { sha256 } from "../security/redaction.js";
import { terminateProcessTree } from "../security/command-policy.js";

export type StubScenario =
  | "worker-success" | "worker-rework" | "auditor-approve" | "auditor-changes" | "schema-failure-once"
  | "timeout" | "subscription-failure" | "prohibited-command" | "prohibited-path" | "crash";

export type StubToolHandler = (tool: string, args: unknown) => Promise<unknown>;

export interface ProcessObserver {
  started(process: { id: string; pid: number; executable: string; startedAt: string }): void;
  stopped(process: { id: string; state: "exited" | "cancelled" | "terminated" }): void;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderUnavailableError"; }
}

export class StubProviderAdapter implements ProviderAdapter {
  readonly provider: ProviderName;
  private child: ChildProcess | undefined;

  constructor(
    provider: "stub-codex" | "stub-claude",
    private readonly scenarios: StubScenario[],
    private readonly toolHandler: StubToolHandler,
    private readonly processObserver?: ProcessObserver
  ) { this.provider = provider; }

  async probe(): Promise<ProviderCapabilities> {
    const authentication = await this.authenticate();
    return ProviderCapabilities.parse({
      schemaVersion: SCHEMA_VERSION, provider: this.provider, platform: `${process.platform}-${process.arch}`,
      executable: { available: true, resolvedPathHash: sha256(fileURLToPath(new URL("../stubs/provider-cli.ts", import.meta.url))), version: "stub-1.0.0" },
      authentication,
      structuredOutput: { supported: true, schemaEnforced: true, evidenceRef: "stub-contract" },
      resume: { exactId: true, name: true, latest: true, nativePicker: false },
      customizationIsolation: { supported: true, repositoryInstructionsSuppressed: true, managedPolicyMayApply: false, evidenceRef: "stub-contract" },
      toolRestriction: { supported: true, brokerOnly: true, evidenceRef: "stub-contract" },
      sandboxing: { readOnly: true, workspaceWrite: true, outsideWorktreeDenied: true, evidenceRef: "local-security-proofs" },
      cancellation: { graceful: true, processTree: true, evidenceRef: "stub-cancellation-test" },
      knownIncompatibilities: [], probedAt: new Date().toISOString()
    });
  }

  async authenticate(): Promise<AuthenticationProof> {
    return AuthenticationProof.parse({
      state: "SUBSCRIPTION_VERIFIED", command: ["stub", "auth", "status"], exitCode: 0,
      observedFieldNames: ["stub"], stdoutRedacted: "stub subscription verified", stderrRedacted: "",
      evidenceHash: sha256(`${this.provider}:subscription`), probedAt: new Date().toISOString()
    });
  }

  async runTurn<T>(request: ProviderTurnRequest<T>, signal?: AbortSignal): Promise<ProviderTurnResult<T>> {
    const scenario = this.scenarios.shift() ?? (request.purpose === "REVIEW" || request.purpose === "FINAL_REVIEW" ? "auditor-approve" : "worker-success");
    return await this.execute(request, scenario, false, signal);
  }

  private async execute<T>(request: ProviderTurnRequest<T>, scenario: StubScenario, correction: boolean, signal?: AbortSignal): Promise<ProviderTurnResult<T>> {
    const script = fileURLToPath(new URL("../stubs/provider-cli.ts", import.meta.url));
    const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const args = ["--import", tsxLoader, script, "--provider", this.provider, "--scenario", scenario];
    const resume = request.session && (request.session.mode === "resume-id" || request.session.mode === "resume-name") ? request.session.value : undefined;
    if (resume) args.push("--session-id", resume);
    if (correction) args.push("--correction");
    const events: unknown[] = [];
    let raw = "";
    let stderr = "";
    let sessionId: string = randomUUID();
    let finalOutput: unknown;
    let policyError: Error | undefined;
    const child = spawn(process.execPath, args, { cwd: request.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const processRecordId = randomUUID();
    if (child.pid) this.processObserver?.started({ id: processRecordId, pid: child.pid, executable: process.execPath, startedAt: new Date().toISOString() });
    const timeout = setTimeout(() => { if (child.pid) void terminateProcessTree(child.pid); }, request.timeoutMs);
    const onAbort = (): void => { if (child.pid) void terminateProcessTree(child.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let pending = Promise.resolve();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      raw += chunk;
      const lines = raw.split(/\r?\n/);
      raw = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        pending = pending.then(async () => {
          const event = JSON.parse(line) as Record<string, unknown>;
          events.push(event);
          if (event.type === "session.started" && typeof event.sessionId === "string") sessionId = event.sessionId;
          if (event.type === "tool.call" && typeof event.tool === "string") {
            try { await this.toolHandler(event.tool, event.arguments); }
            catch (error) {
              policyError = error instanceof Error ? error : new Error(String(error));
              if (child.pid) await terminateProcessTree(child.pid);
            }
          }
          if (event.type === "turn.completed") finalOutput = event.output;
          if (event.type === "error" && event.code === "subscription_exhausted") policyError = new ProviderUnavailableError("PROVIDER_UNAVAILABLE: subscription exhausted");
        });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await pending;
    this.child = undefined;
    this.processObserver?.stopped({ id: processRecordId, state: signal?.aborted ? "cancelled" : exitCode === 0 ? "exited" : "terminated" });
    if (signal?.aborted) throw new Error("TURN_CANCELLED");
    if (policyError) throw policyError;
    if (exitCode !== 0) throw new Error(`STUB_PROVIDER_FAILED: ${exitCode} ${stderr}`);
    const parsed = request.outputSchema.safeParse(finalOutput);
    if (!parsed.success) {
      if (correction) throw new Error(`SCHEMA_CORRECTION_EXHAUSTED: ${parsed.error.message}`);
      return await this.execute(request, scenario, true, signal).then((value) => ({ ...value, schemaCorrectionUsed: true }));
    }
    return {
      provider: this.provider,
      nativeSessionId: sessionId,
      sessionIdHash: sha256(sessionId),
      freshSession: !request.session || request.session.mode === "new",
      purpose: request.purpose,
      output: parsed.data,
      eventCount: events.length,
      rawLogHash: sha256(JSON.stringify(events)),
      schemaCorrectionUsed: correction,
      eventSummary: {
        types: [...new Set(events.map((event) => event && typeof event === "object" && "type" in event ? String((event as { type: unknown }).type) : "unknown"))].sort(),
        toolNames: [...new Set(events.flatMap((event) => event && typeof event === "object" && (event as { type?: unknown }).type === "tool.call" ? [String((event as { tool?: unknown }).tool)] : []))].sort(),
        availableToolNames: [],
        mcpServerStatuses: [],
        toolOutcomes: []
      }
    };
  }

  async cancel(): Promise<void> {
    if (this.child?.pid) await terminateProcessTree(this.child.pid);
  }
}
