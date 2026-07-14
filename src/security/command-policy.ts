import path from "node:path";
import { spawn } from "node:child_process";
import type { SafeEnvironment } from "./environment.js";
import type { PathPolicy } from "./path-policy.js";
import { sha256 } from "./redaction.js";

export interface CommandRule {
  executable: string;
  args: readonly string[];
  match: "exact" | "prefix";
}

export interface CommandRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export interface CommandDecision {
  allowed: boolean;
  code: string;
  reason: string;
  rule?: CommandRule;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  outputHash: string;
}

function baseExecutable(executable: string): string {
  const crossPlatformBase = executable.replaceAll("\\", "/").split("/").at(-1) ?? executable;
  return crossPlatformBase.replace(/\.(exe|cmd|bat|ps1|sh)$/i, "").toLowerCase();
}

function normalizedArgs(args: readonly string[]): string[] {
  return args.map((arg) => arg.toLowerCase());
}

function executableMatches(ruleExecutable: string, requestedExecutable: string): boolean {
  if (path.isAbsolute(ruleExecutable)) {
    if (!path.isAbsolute(requestedExecutable)) return false;
    const rule = path.normalize(ruleExecutable);
    const requested = path.normalize(requestedExecutable);
    return process.platform === "win32" ? rule.toLowerCase() === requested.toLowerCase() : rule === requested;
  }
  return baseExecutable(ruleExecutable) === baseExecutable(requestedExecutable);
}

export function hardDenial(request: Pick<CommandRequest, "executable" | "args">): CommandDecision | undefined {
  const executable = baseExecutable(request.executable);
  const args = normalizedArgs(request.args);
  if (["cmd", "powershell", "pwsh", "bash", "zsh", "sh", "wsl"].includes(executable)) {
    return { allowed: false, code: "SHELL_FORBIDDEN", reason: "Arbitrary shells are never provider tools" };
  }
  if (executable === "git") {
    if (args.some((arg) => /^alias\./.test(arg) || arg.includes("alias."))) {
      return { allowed: false, code: "GIT_ALIAS_FORBIDDEN", reason: "Git aliases can bypass subcommand policy" };
    }
    const denied = ["commit", "push", "merge", "rebase", "reset", "clean"];
    const hit = denied.find((command) => args.includes(command));
    if (hit) return { allowed: false, code: "GIT_MUTATION_FORBIDDEN", reason: `git ${hit} is hard-denied` };
  }
  if (executable === "gh" && args.includes("pr") && args.includes("merge")) {
    return { allowed: false, code: "PR_MERGE_FORBIDDEN", reason: "gh pr merge is hard-denied" };
  }
  if (executable === "gcloud" || executable === "supabase") {
    return { allowed: false, code: "DEPLOY_TOOL_FORBIDDEN", reason: `${executable} is hard-denied` };
  }
  if (executable === "terraform" && args.includes("apply")) {
    return { allowed: false, code: "TERRAFORM_APPLY_FORBIDDEN", reason: "terraform apply is hard-denied" };
  }
  if (executable === "kubectl" && args.includes("apply")) {
    return { allowed: false, code: "KUBECTL_APPLY_FORBIDDEN", reason: "kubectl apply is hard-denied" };
  }
  if (["npm", "pnpm"].includes(executable) && args.includes("publish")) {
    return { allowed: false, code: "PUBLISH_FORBIDDEN", reason: `${executable} publish is hard-denied` };
  }
  return undefined;
}

export class CommandPolicy {
  constructor(private readonly allowedRules: readonly CommandRule[]) {}

  decide(request: Pick<CommandRequest, "executable" | "args">): CommandDecision {
    const denied = hardDenial(request);
    if (denied) return denied;
    for (const rule of this.allowedRules) {
      if (!executableMatches(rule.executable, request.executable)) continue;
      const requestedArgs = [...request.args];
      const matches = rule.match === "exact"
        ? requestedArgs.length === rule.args.length && requestedArgs.every((arg, index) => arg === rule.args[index])
        : rule.args.every((arg, index) => requestedArgs[index] === arg);
      if (matches) return { allowed: true, code: "ALLOWED", reason: "Matched an explicit command rule", rule };
    }
    return { allowed: false, code: "DEFAULT_DENY", reason: "No exact project or validation rule matched" };
  }
}

export async function terminateProcessTree(pid: number, platform = process.platform): Promise<void> {
  if (platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

export class CommandBroker {
  constructor(
    private readonly policy: CommandPolicy,
    private readonly paths: PathPolicy,
    private readonly environment: SafeEnvironment,
    private readonly maxOutputBytes = 20 * 1024 * 1024
  ) {}

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const decision = this.policy.decide(request);
    if (!decision.allowed) throw new Error(`${decision.code}: ${decision.reason}`);
    const cwd = await this.paths.assertDirectory(request.cwd);
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd,
        env: this.environment.values,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let outputTruncated = false;
      let timedOut = false;
      let cancelled = false;
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const current = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
        const remaining = this.maxOutputBytes - current;
        if (remaining <= 0) { outputTruncated = true; return; }
        const value = chunk.subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += value; else stderr += value;
        if (chunk.length > remaining) outputTruncated = true;
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", reject);
      const stop = async (kind: "timeout" | "cancel"): Promise<void> => {
        if (!child.pid) return;
        if (kind === "timeout") timedOut = true; else cancelled = true;
        child.kill("SIGTERM");
        const grace = setTimeout(() => void terminateProcessTree(child.pid!), 1_000);
        grace.unref();
      };
      const timer = setTimeout(() => void stop("timeout"), Math.max(1, request.timeoutMs));
      const onAbort = (): void => { void stop("cancel"); };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const marker = outputTruncated ? "\n[CODERELAY OUTPUT TRUNCATED]" : "";
        if (outputTruncated) stderr += marker;
        resolve({ exitCode, stdout, stderr, timedOut, cancelled, outputTruncated, outputHash: sha256(`${stdout}\n${stderr}`) });
      });
    });
  }
}
