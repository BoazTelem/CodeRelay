import path from "node:path";
import { runCaptured } from "../platform/services.js";
import { sha256 } from "../security/redaction.js";

export interface GitRunnerOptions { executable: string; repository: string; }

export class TrustedGit {
  constructor(private readonly options: GitRunnerOptions) {}

  async run(args: readonly string[], repository = this.options.repository, allowFailure = false): Promise<string> {
    const result = await runCaptured(this.options.executable, ["-C", repository, ...args], { timeoutMs: 30_000 });
    if (!allowFailure && result.exitCode !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr || result.stdout}`);
    return result.exitCode === 0 ? result.stdout : "";
  }

  get executable(): string { return this.options.executable; }
  get repository(): string { return this.options.repository; }
}

export interface GitSnapshot {
  branch: string;
  head: string;
  status: string;
  workingDiff: string;
  indexDiff: string;
  untrackedFiles: string[];
  fingerprint: string;
}

export async function captureGitSnapshot(git: TrustedGit, repository = git.repository): Promise<GitSnapshot> {
  const [branch, head, status, workingDiff, indexDiff, untracked] = await Promise.all([
    git.run(["branch", "--show-current"], repository),
    git.run(["rev-parse", "HEAD"], repository),
    git.run(["status", "--porcelain=v1", "--untracked-files=all"], repository),
    git.run(["diff", "--no-ext-diff", "--binary"], repository),
    git.run(["diff", "--cached", "--no-ext-diff", "--binary"], repository),
    git.run(["ls-files", "--others", "--exclude-standard"], repository)
  ]);
  const snapshot = {
    branch: branch.trim(), head: head.trim(), status, workingDiff, indexDiff,
    untrackedFiles: untracked.split(/\r?\n/).filter(Boolean).sort()
  };
  return { ...snapshot, fingerprint: sha256(JSON.stringify(snapshot)) };
}

export async function createIsolatedWorktree(git: TrustedGit, worktreePath: string, branch: string, baseCommit: string): Promise<void> {
  if (!branch.startsWith("coderelay/")) throw new Error("CodeRelay branches must use the coderelay/ namespace");
  await git.run(["worktree", "add", "-b", branch, worktreePath, baseCommit]);
}

export async function restoreIsolatedCheckpoint(
  git: TrustedGit,
  primaryRoot: string,
  worktreeRoot: string,
  checkpoint: string,
  branch: string
): Promise<void> {
  if (path.resolve(primaryRoot) === path.resolve(worktreeRoot)) throw new Error("Refusing to restore the primary checkout");
  if (!branch.startsWith("coderelay/")) throw new Error("Refusing to restore a non-CodeRelay branch");
  const actualBranch = (await git.run(["branch", "--show-current"], worktreeRoot)).trim();
  if (actualBranch !== branch) throw new Error("Worktree branch does not match the recorded CodeRelay branch");
  await git.run(["reset", "--hard", checkpoint], worktreeRoot);
  await git.run(["clean", "-fd"], worktreeRoot);
}
