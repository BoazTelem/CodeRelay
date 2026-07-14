import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { TaskContract, ValidationResult } from "../contracts/schemas.js";
import { SCHEMA_VERSION } from "../contracts/schemas.js";
import { PathPolicy } from "../security/path-policy.js";
import { buildSafeEnvironment } from "../security/environment.js";
import { runCaptured } from "../platform/services.js";
import { sha256 } from "../security/redaction.js";

export async function runAuthoritativeValidation(contract: TaskContract, worktreeRoot: string): Promise<ValidationResult[]> {
  const paths = new PathPolicy({ root: worktreeRoot, approvedPaths: ["."] });
  await paths.initialize();
  const safe = buildSafeEnvironment({
    restrictedPath: [...new Set([path.dirname(process.execPath), ...(process.platform === "win32" && process.env.SystemRoot ? [path.join(process.env.SystemRoot, "System32")] : [])])],
    tempDirectory: os.tmpdir(),
    homeDirectory: worktreeRoot
  });
  const results: ValidationResult[] = [];
  for (const command of contract.validationCommands) {
    const cwd = await paths.assertDirectory(command.cwd);
    const startedAt = new Date().toISOString();
    const captured = await runCaptured(command.executable, command.args, { cwd, env: safe.values, timeoutMs: 120_000, maxOutputBytes: 20 * 1024 * 1024 });
    const finishedAt = new Date().toISOString();
    results.push({
      schemaVersion: SCHEMA_VERSION,
      id: `validation_${randomUUID()}`,
      executableHash: sha256(command.executable),
      args: command.args,
      cwdHash: sha256(cwd),
      environmentDigest: safe.digest,
      startedAt,
      finishedAt,
      exitCode: captured.exitCode,
      timedOut: captured.timedOut,
      cancelled: false,
      outputHash: sha256(`${captured.stdout}\n${captured.stderr}`),
      logRef: `inline:${sha256(`${captured.stdout}\n${captured.stderr}`)}`,
      passed: captured.exitCode === 0 && !captured.timedOut
    });
  }
  return results;
}
