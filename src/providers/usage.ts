import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCaptured } from "../platform/services.js";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface ProviderUsage {
  provider: "codex" | "claude";
  capturedAt: string;
  source: "session-log" | "run-event" | "probe";
  windows: UsageWindow[];
  status?: string;
  limitType?: string;
  resetsAt?: number;
  isUsingOverage?: boolean;
  planType?: string;
  creditsBalance?: string;
}

function windowLabel(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
}

function findRateLimits(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.rate_limits && typeof record.rate_limits === "object") return record.rate_limits as Record<string, unknown>;
  for (const entry of Object.values(record)) {
    const nested = findRateLimits(entry);
    if (nested) return nested;
  }
  return undefined;
}

export function normalizeCodexRateLimits(snapshot: Record<string, unknown>, capturedAt: string, source: ProviderUsage["source"]): ProviderUsage {
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = snapshot[key];
    if (window && typeof window === "object") {
      const record = window as Record<string, unknown>;
      if (typeof record.used_percent === "number" && typeof record.window_minutes === "number") {
        windows.push({
          label: windowLabel(record.window_minutes),
          usedPercent: record.used_percent,
          resetsAt: typeof record.resets_at === "number" ? record.resets_at : null
        });
      }
    }
  }
  const credits = snapshot.credits && typeof snapshot.credits === "object" ? snapshot.credits as Record<string, unknown> : undefined;
  return {
    provider: "codex",
    capturedAt,
    source,
    windows,
    ...(typeof snapshot.plan_type === "string" ? { planType: snapshot.plan_type } : {}),
    ...(credits && typeof credits.balance === "string" && credits.has_credits === true ? { creditsBalance: credits.balance } : {}),
    ...(snapshot.rate_limit_reached_type ? { status: "limited", limitType: String(snapshot.rate_limit_reached_type) } : { status: "allowed" })
  };
}

export function normalizeClaudeRateLimitEvent(info: Record<string, unknown>, capturedAt: string, source: ProviderUsage["source"]): ProviderUsage {
  return {
    provider: "claude",
    capturedAt,
    source,
    windows: [],
    ...(typeof info.status === "string" ? { status: info.status } : {}),
    ...(typeof info.rateLimitType === "string" ? { limitType: info.rateLimitType } : {}),
    ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
    ...(typeof info.isUsingOverage === "boolean" ? { isUsingOverage: info.isUsingOverage } : {})
  };
}

async function newestRolloutFile(sessionsRoot: string): Promise<string | undefined> {
  let newest: { path: string; mtimeMs: number } | undefined;
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(full);
          if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: info.mtimeMs };
        } catch { /* skip unreadable */ }
      }
    }
  };
  await walk(sessionsRoot, 0);
  return newest?.path;
}

/** Reads the latest rate-limit snapshot Codex recorded in its own session logs. No network access. */
export async function readCodexUsage(codexHome?: string): Promise<ProviderUsage | undefined> {
  const home = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const file = await newestRolloutFile(path.join(home, "sessions"));
  if (!file) return undefined;
  let content: string;
  try { content = await readFile(file, "utf8"); } catch { return undefined; }
  const lines = content.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes("\"rate_limits\"")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const snapshot = findRateLimits(parsed);
      if (!snapshot) continue;
      const capturedAt = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date((await stat(file)).mtimeMs).toISOString();
      return normalizeCodexRateLimits(snapshot, capturedAt, "session-log");
    } catch { /* keep scanning */ }
  }
  return undefined;
}

/**
 * Runs one minimal Claude turn purely to observe the stream's rate_limit_event.
 * Costs a single small request against the user's subscription; only invoked by
 * an explicit user action in the UI.
 */
export async function probeClaudeUsage(executable: string, environment?: NodeJS.ProcessEnv): Promise<ProviderUsage | undefined> {
  const result = await runCaptured(executable, [
    "-p", "Reply with exactly: OK",
    "--output-format", "stream-json",
    "--verbose",
    "--model", "claude-haiku-4-5-20251001",
    "--max-turns", "1"
  ], { timeoutMs: 60_000, ...(environment ? { env: environment } : {}) });
  if (result.exitCode !== 0) return undefined;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "rate_limit_event" && event.rate_limit_info && typeof event.rate_limit_info === "object") {
        return normalizeClaudeRateLimitEvent(event.rate_limit_info as Record<string, unknown>, new Date().toISOString(), "probe");
      }
    } catch { /* skip unparsable lines */ }
  }
  return undefined;
}

/** Extracts a usage snapshot from already-parsed provider stream events, if any. */
export function usageFromEvents(provider: "codex" | "claude", events: ReadonlyArray<Record<string, unknown>>): ProviderUsage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (provider === "claude" && event.type === "rate_limit_event" && event.rate_limit_info && typeof event.rate_limit_info === "object") {
      return normalizeClaudeRateLimitEvent(event.rate_limit_info as Record<string, unknown>, new Date().toISOString(), "run-event");
    }
    if (provider === "codex") {
      const snapshot = findRateLimits(event);
      if (snapshot) return normalizeCodexRateLimits(snapshot, new Date().toISOString(), "run-event");
    }
  }
  return undefined;
}
