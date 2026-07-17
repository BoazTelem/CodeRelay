import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import {
  AuthenticationProof, ProviderCapabilities, SCHEMA_VERSION,
  type ProviderName
} from "../contracts/schemas.js";
import type { ProviderAdapter, ProviderEventSummary, ProviderTurnRequest, ProviderTurnResult } from "./types.js";
import { normalizeClaudeAuthentication, normalizeCodexAuthentication } from "./auth.js";
import { buildClaudeRestrictedInvocation, buildCodexRestrictedInvocation } from "./invocations.js";
import { runCaptured } from "../platform/services.js";
import { redactText, sha256 } from "../security/redaction.js";
import { terminateProcessTree } from "../security/command-policy.js";
import { ProviderUnavailableError } from "./stub-adapter.js";
import type { ProcessObserver } from "./stub-adapter.js";
import { STAGE_PROMPTS } from "../orchestrator/prompts.js";
import { usageFromEvents, type ProviderUsage } from "./usage.js";

export interface RealProviderAdapterOptions {
  provider: "codex" | "claude";
  executable: string;
  environment: NodeJS.ProcessEnv;
  artifactDirectory: string;
  mcpServer?: { command: string; args: string[] };
  processObserver?: ProcessObserver;
  usageObserver?: (usage: ProviderUsage) => void;
}

interface ProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

interface RawTurn {
  output: unknown;
  nativeSessionId: string;
  eventCount: number;
  rawLogHash: string;
  eventSummary: ProviderEventSummary;
}

function advertised(help: string, flag: string): boolean { return help.includes(flag); }

export function buildProviderJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  if (converted.type !== "object") throw new Error("PROVIDER_SCHEMA_INVALID: workflow output schemas must have a top-level object type");
  return converted;
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

export function redactLaunchValue(value: string): string {
  return ABSOLUTE_PATH.test(value) ? sha256(value) : value;
}

export function redactLaunchArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => index > 0 && args[index - 1] === "--nonce" ? "[REDACTED_NONCE]" : redactLaunchValue(arg));
}

function redactDiagnosticText(value: string): string {
  return redactText(value)
    .replace(/\b[A-Za-z]:[\\/][^\s"'`]+/g, "[REDACTED_PATH]")
    .replace(/(^|[\s("'`])\/(?:[^/\s"'`]+\/)+[^\s"'`]*/gm, "$1[REDACTED_PATH]");
}

function errorStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(errorStrings);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return ["message", "error", "result", "reason", "detail"]
    .flatMap((key) => key in record ? errorStrings(record[key]) : []);
}

export function summarizeProviderFailure(output: Pick<ProcessOutput, "stdout" | "stderr" | "exitCode">): string {
  const stderr = redactDiagnosticText(output.stderr.trim());
  if (stderr) return stderr.slice(0, 2_000);

  const eventTypes = new Set<string>();
  const messages: string[] = [];
  for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "unknown";
      const subtype = typeof event.subtype === "string" ? event.subtype : "";
      eventTypes.add(subtype ? `${type}:${subtype}` : type);
      const errorEvent = event.is_error === true || /error|fail/i.test(`${type} ${subtype}`);
      if (errorEvent) messages.push(...errorStrings(event));
    } catch {
      eventTypes.add("unparsed");
    }
  }
  const details = [...new Set(messages.map((message) => redactDiagnosticText(message).trim()).filter(Boolean))].join(" | ");
  const metadata = `stdoutHash=${sha256(output.stdout)}; events=${[...eventTypes].sort().join(",") || "none"}`;
  return details ? `${details.slice(0, 1_500)}; ${metadata}` : `No provider diagnostic text; ${metadata}`;
}

export class RealProviderAdapter implements ProviderAdapter {
  readonly provider: ProviderName;
  private child: ChildProcess | undefined;
  private runtimePath: string | undefined;

  constructor(private readonly options: RealProviderAdapterOptions) { this.provider = options.provider; }

  private async runtimeDirectory(): Promise<string> {
    this.runtimePath ??= await mkdtemp(path.join(os.tmpdir(), "coderelay-runtime-"));
    return this.runtimePath;
  }

  async authenticate(): Promise<AuthenticationProof> {
    const result = await runCaptured(
      this.options.executable,
      this.options.provider === "codex" ? ["login", "status"] : ["auth", "status"],
      { env: this.options.environment, timeoutMs: 15_000 }
    );
    return this.options.provider === "codex" ? normalizeCodexAuthentication(result) : normalizeClaudeAuthentication(result);
  }

  async probe(): Promise<ProviderCapabilities> {
    const [version, help, authentication] = await Promise.all([
      runCaptured(this.options.executable, ["--version"], { env: this.options.environment, timeoutMs: 10_000 }),
      runCaptured(this.options.executable, ["--help"], { env: this.options.environment, timeoutMs: 10_000 }),
      this.authenticate()
    ]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const isCodex = this.options.provider === "codex";
    return ProviderCapabilities.parse({
      schemaVersion: SCHEMA_VERSION,
      provider: this.options.provider,
      platform: `${process.platform}-${process.arch}`,
      executable: {
        available: version.exitCode === 0,
        resolvedPathHash: sha256(this.options.executable),
        ...(version.stdout.trim() ? { version: redactText(version.stdout.trim()).slice(0, 200) } : {}),
        ...(version.exitCode !== 0 ? { error: redactText(version.spawnError ?? version.stderr).slice(0, 300) } : {})
      },
      authentication,
      structuredOutput: { supported: advertised(helpText, isCodex ? "exec" : "--json-schema"), schemaEnforced: false, reason: "Requires active fixture proof" },
      resume: {
        exactId: advertised(helpText, isCodex ? "resume" : "--resume"),
        name: !isCodex && advertised(helpText, "--name"),
        latest: advertised(helpText, isCodex ? "resume" : "--continue"),
        nativePicker: advertised(helpText, "resume")
      },
      customizationIsolation: { supported: advertised(helpText, isCodex ? "--ignore-user-config" : "--safe-mode"), repositoryInstructionsSuppressed: false, managedPolicyMayApply: !isCodex, reason: "Requires active marker proof" },
      toolRestriction: { supported: advertised(helpText, isCodex ? "--disable" : "--tools"), brokerOnly: false, reason: "Requires active event proof" },
      sandboxing: { readOnly: isCodex ? advertised(helpText, "read-only") : true, workspaceWrite: isCodex ? advertised(helpText, "workspace-write") : true, outsideWorktreeDenied: false },
      cancellation: { graceful: false, processTree: false },
      knownIncompatibilities: [],
      probedAt: new Date().toISOString()
    });
  }

  async runTurn<T>(request: ProviderTurnRequest<T>, signal?: AbortSignal): Promise<ProviderTurnResult<T>> {
    const first = await this.runOnce(request, request.prompt, request.session, signal);
    let parsed = request.outputSchema.safeParse(first.output);
    if (parsed.success) return this.result(request, first, parsed.data, false);
    const correctionPrompt = `${STAGE_PROMPTS.SCHEMA_CORRECTION}\n\nValidation errors:\n${parsed.error.message}`;
    const corrected = await this.runOnce(request, correctionPrompt, { mode: "resume-id", value: first.nativeSessionId }, signal);
    parsed = request.outputSchema.safeParse(corrected.output);
    if (!parsed.success) throw new Error(`SCHEMA_CORRECTION_EXHAUSTED: ${parsed.error.message}`);
    return this.result(request, corrected, parsed.data, true);
  }

  private result<T>(request: ProviderTurnRequest<T>, raw: RawTurn, output: T, schemaCorrectionUsed: boolean): ProviderTurnResult<T> {
    return {
      provider: this.provider,
      nativeSessionId: raw.nativeSessionId,
      sessionIdHash: sha256(raw.nativeSessionId),
      freshSession: !request.session || request.session.mode === "new",
      purpose: request.purpose,
      output,
      eventCount: raw.eventCount,
      rawLogHash: raw.rawLogHash,
      schemaCorrectionUsed,
      eventSummary: raw.eventSummary
    };
  }

  private async runOnce<T>(
    request: ProviderTurnRequest<T>,
    prompt: string,
    session: ProviderTurnRequest<T>["session"],
    signal?: AbortSignal
  ): Promise<RawTurn> {
    await mkdir(this.options.artifactDirectory, { recursive: true });
    const turnId = randomUUID();
    const schemaPath = path.join(this.options.artifactDirectory, `${turnId}.schema.json`);
    const outputPath = path.join(this.options.artifactDirectory, `${turnId}.output.json`);
    const schema = buildProviderJsonSchema(request.outputSchema as z.ZodTypeAny);
    await writeFile(schemaPath, `${JSON.stringify(schema)}\n`, "utf8");

    let executable: string;
    let args: string[];
    if (this.options.provider === "codex") {
      const overrides = this.options.mcpServer ? [
        "-c", `mcp_servers.coderelay.command=${JSON.stringify(this.options.mcpServer.command)}`,
        "-c", `mcp_servers.coderelay.args=${JSON.stringify(this.options.mcpServer.args)}`,
        "-c", "mcp_servers.coderelay.required=true",
        "-c", `mcp_servers.coderelay.enabled_tools=${JSON.stringify(["read_file", "list_files", "search", "apply_patch", "run_command"])}`,
        "-c", `mcp_servers.coderelay.default_tools_approval_mode=${JSON.stringify("approve")}`
      ] : [];
      const resume = session && session.mode !== "new"
        ? session.mode === "latest" ? { mode: "latest" as const } : { mode: "id" as const, value: session.value }
        : undefined;
      const invocation = buildCodexRestrictedInvocation({
        executable: this.options.executable,
        access: request.access,
        prompt: "-",
        schemaPath,
        outputPath,
        mcpConfigOverrides: overrides,
        ...(resume ? { resume } : {})
      });
      executable = invocation.executable;
      args = invocation.args;
    } else {
      const mcpPath = path.join(await this.runtimeDirectory(), `${turnId}.mcp.json`);
      const mcpServers = this.options.mcpServer
        ? { coderelay: { command: this.options.mcpServer.command, args: this.options.mcpServer.args } }
        : {};
      await writeFile(mcpPath, JSON.stringify({ mcpServers }), "utf8");
      const redactedServers = this.options.mcpServer
        ? { coderelay: { command: redactLaunchValue(this.options.mcpServer.command), args: redactLaunchArgs(this.options.mcpServer.args) } }
        : {};
      await writeFile(path.join(this.options.artifactDirectory, `${turnId}.mcp.json`), `${JSON.stringify({ mcpServers: redactedServers })}\n`, "utf8");
      const resume = session && session.mode !== "new"
        ? session.mode === "latest" ? { mode: "latest" as const } : { mode: "id-or-name" as const, value: session.value }
        : undefined;
      const invocation = buildClaudeRestrictedInvocation({
        executable: this.options.executable,
        schemaJson: JSON.stringify(schema),
        mcpConfigPath: mcpPath,
        mcpEnabled: this.options.mcpServer !== undefined,
        ...(resume ? { resume } : {})
      });
      executable = invocation.executable;
      args = invocation.args;
    }

    const captured = await this.spawnTurn(executable, args, prompt, request.cwd, request.timeoutMs, signal);
    if (captured.cancelled) throw new Error("TURN_CANCELLED");
    if (captured.timedOut) throw new Error("TURN_TIMEOUT");
    if (captured.truncated) throw new Error("RAW_LOG_LIMIT_EXCEEDED: provider output exceeded 20 MiB");
    if (captured.exitCode !== 0) {
      if (/usage limit|subscription.*(?:limit|exhaust)|quota|rate limit|credit/i.test(`${captured.stderr}\n${captured.stdout}`)) {
        throw new ProviderUnavailableError("PROVIDER_UNAVAILABLE: subscription or usage limit");
      }
      throw new Error(`${this.options.provider.toUpperCase()}_TURN_FAILED: ${captured.exitCode} ${summarizeProviderFailure(captured)}`);
    }
    const events = captured.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return { type: "unparsed" }; }
    });
    if (this.options.usageObserver) {
      const usage = usageFromEvents(this.options.provider, events);
      if (usage) this.options.usageObserver(usage);
    }
    const summary = summarizeEvents(events);
    let output: unknown;
    let nativeSessionId = summary.sessionId;
    if (this.options.provider === "codex") {
      const final = await readFile(outputPath, "utf8");
      output = JSON.parse(final);
    } else {
      const resultEvent = [...events].reverse().find((event) => event.type === "result");
      output = resultEvent?.structured_output;
      nativeSessionId ||= typeof resultEvent?.session_id === "string" ? resultEvent.session_id : "";
      if (output === undefined && typeof resultEvent?.result === "string") {
        try { output = JSON.parse(resultEvent.result); } catch { output = resultEvent.result; }
      }
    }
    if (!nativeSessionId) throw new Error("SESSION_ID_MISSING: provider did not emit a resumable session identifier");
    return {
      output,
      nativeSessionId,
      eventCount: events.length,
      rawLogHash: sha256(`${captured.stdout}\n${captured.stderr}`),
      eventSummary: summary
    };
  }

  private async spawnTurn(
    executable: string,
    args: string[],
    stdin: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ProcessOutput> {
    return await new Promise<ProcessOutput>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let truncated = false;
      const maxBytes = 20 * 1024 * 1024;
      const child = spawn(executable, args, { cwd, env: this.options.environment, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      const processRecordId = randomUUID();
      if (child.pid) this.options.processObserver?.started({ id: processRecordId, pid: child.pid, executable, startedAt: new Date().toISOString() });
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const remaining = maxBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
        if (remaining <= 0) { truncated = true; return; }
        const value = chunk.subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += value; else stderr += value;
        if (chunk.length > remaining) truncated = true;
      };
      child.stdout!.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr!.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", reject);
      child.stdin!.end(stdin);
      const stop = async (reason: "timeout" | "cancel"): Promise<void> => {
        if (reason === "timeout") timedOut = true; else cancelled = true;
        if (child.pid) await terminateProcessTree(child.pid);
      };
      const timer = setTimeout(() => void stop("timeout"), timeoutMs);
      const onAbort = (): void => { void stop("cancel"); };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.child = undefined;
        this.options.processObserver?.stopped({ id: processRecordId, state: cancelled ? "cancelled" : exitCode === 0 ? "exited" : "terminated" });
        if (truncated) stderr += "\n[CODERELAY RAW LOG TRUNCATED]";
        resolve({ exitCode, stdout, stderr, timedOut, cancelled, truncated });
      });
    });
  }

  async cancel(): Promise<void> {
    if (this.child?.pid) await terminateProcessTree(this.child.pid);
  }
}

function summarizeEvents(events: Array<Record<string, unknown>>): ProviderEventSummary & { sessionId: string } {
  const types = new Set<string>();
  const toolNames = new Set<string>();
  const availableToolNames = new Set<string>();
  const mcpServerStatuses = new Set<string>();
  const toolOutcomes = new Set<string>();
  const toolUseNames = new Map<string, string>();
  let sessionId = "";
  const visitContent = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visitContent); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of ["type", "subtype", "hook_event_name", "hookEventName"]) {
      if (typeof record[key] === "string") types.add(`${key}:${record[key]}`);
    }
    if (record.type === "system" && record.subtype === "init") {
      if (Array.isArray(record.tools)) {
        for (const tool of record.tools) if (typeof tool === "string") availableToolNames.add(tool);
      }
      if (Array.isArray(record.mcp_servers)) {
        for (const server of record.mcp_servers) {
          if (!server || typeof server !== "object") continue;
          const item = server as Record<string, unknown>;
          const name = typeof item.name === "string" ? item.name : "unknown";
          const status = typeof item.status === "string" ? item.status : "unknown";
          mcpServerStatuses.add(`${name}:${status}`);
        }
      }
    }
    if (record.type === "tool_use" && typeof record.name === "string") {
      // Claude implements --json-schema through an internal synthetic tool. It
      // is schema enforcement, not an executable capability granted to an agent.
      if (record.name !== "StructuredOutput") toolNames.add(record.name);
      if (typeof record.id === "string") toolUseNames.set(record.id, record.name);
    }
    if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
      const name = toolUseNames.get(record.tool_use_id) ?? "unknown";
      const status = record.is_error === true ? "error" : "success";
      const diagnostic = record.is_error === true
        ? errorStrings(record).map(redactDiagnosticText).filter(Boolean).join(" | ")
        : "";
      toolOutcomes.add(`${name}:${status}${diagnostic ? `:${diagnostic.slice(0, 300)}` : ""}`);
    }
    if (record.type === "mcp_tool_call") {
      const server = typeof record.server === "string" ? record.server : "mcp";
      const tool = typeof record.tool === "string" ? record.tool : typeof record.name === "string" ? record.name : "unknown";
      const name = `${server}/${tool}`;
      toolNames.add(name);
      const status = typeof record.status === "string" ? record.status : record.error ? "error" : "unknown";
      const diagnostic = record.error
        ? errorStrings(record.error).map(redactDiagnosticText).filter(Boolean).join(" | ")
        : "";
      toolOutcomes.add(`${name}:${status}${diagnostic ? `:${diagnostic.slice(0, 300)}` : ""}`);
    }
    Object.values(record).forEach(visitContent);
  };
  for (const event of events) {
    if (typeof event.type === "string") types.add(event.type);
    const possible = [event.thread_id, event.threadId, event.session_id, event.sessionId].find((value) => typeof value === "string");
    if (typeof possible === "string") sessionId ||= possible;
    visitContent(event);
  }
  return {
    types: [...types].sort(),
    toolNames: [...toolNames].sort(),
    availableToolNames: [...availableToolNames].sort(),
    mcpServerStatuses: [...mcpServerStatuses].sort(),
    toolOutcomes: [...toolOutcomes].sort(),
    sessionId
  };
}
