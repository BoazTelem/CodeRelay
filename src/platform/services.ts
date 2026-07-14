import { access, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { sha256 } from "../security/redaction.js";
import { terminateProcessTree } from "../security/command-policy.js";

export interface ExecutableCandidate {
  name: string;
  path: string;
  pathHash: string;
}

export interface CapturedProcess {
  executable: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export interface ApplicationPaths {
  configuration: string;
  data: string;
  database: string;
  logs: string;
  artifacts: string;
  backups: string;
  worktrees: string;
}

function extensions(platform: NodeJS.Platform, source: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return [""];
  const configured = source.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"];
  return ["", ...configured.map((entry) => entry.toLowerCase())];
}

export async function discoverExecutables(
  aliases: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<ExecutableCandidate[]> {
  const directories = (source.PATH ?? "").split(path.delimiter).filter(Boolean);
  const results = new Map<string, ExecutableCandidate>();
  for (const alias of aliases) {
    const hasExtension = path.extname(alias) !== "";
    for (const directory of directories) {
      for (const extension of hasExtension ? [""] : extensions(platform, source)) {
        const candidate = path.resolve(directory, `${alias}${extension}`);
        try {
          await access(candidate);
          let resolved = candidate;
          try { resolved = await realpath(candidate); } catch { /* app execution aliases can deny resolution */ }
          const key = platform === "win32" ? resolved.toLowerCase() : resolved;
          results.set(key, { name: alias, path: resolved, pathHash: sha256(resolved) });
        } catch { /* not an executable candidate */ }
      }
    }
  }
  return [...results.values()];
}

export async function runCaptured(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<CapturedProcess> {
  return await new Promise<CapturedProcess>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const max = options.maxOutputBytes ?? 2 * 1024 * 1024;
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ executable, args: [...args], exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: message });
      return;
    }
    const append = (current: string, chunk: Buffer): string => {
      const remaining = max - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
      return remaining > 0 ? current + chunk.subarray(0, remaining).toString("utf8") : current;
    };
    child.stdout!.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void terminateProcessTree(child.pid);
    }, options.timeoutMs ?? 10_000);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ executable, args: [...args], exitCode: null, stdout, stderr, timedOut, spawnError: error.message });
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ executable, args: [...args], exitCode, stdout, stderr, timedOut });
    });
  });
}

export function applicationPaths(platform = process.platform, env: NodeJS.ProcessEnv = process.env): ApplicationPaths {
  if (platform === "win32") {
    const roaming = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    const local = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    const configuration = path.join(roaming, "CodeRelay");
    const data = path.join(local, "CodeRelay");
    return derivePaths(configuration, data);
  }
  if (platform === "darwin") {
    const data = path.join(os.homedir(), "Library", "Application Support", "CodeRelay");
    return derivePaths(data, data);
  }
  const configuration = path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "CodeRelay");
  const data = path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "CodeRelay");
  return derivePaths(configuration, data);
}

function derivePaths(configuration: string, data: string): ApplicationPaths {
  return {
    configuration,
    data,
    database: path.join(data, "database", "coderelay.sqlite"),
    logs: path.join(data, "logs"),
    artifacts: path.join(data, "artifacts"),
    backups: path.join(data, "backups"),
    worktrees: path.join(data, "worktrees")
  };
}

export class DefaultPlatformServices {
  readonly platform = process.platform;
  readonly architecture = process.arch;

  applicationPaths(): ApplicationPaths { return applicationPaths(); }
  discover(aliases: readonly string[]): Promise<ExecutableCandidate[]> { return discoverExecutables(aliases); }
  terminateTree(pid: number): Promise<void> { return terminateProcessTree(pid, this.platform); }
}
