import path from "node:path";
import { realpath } from "node:fs/promises";
import { TrustedGit } from "./git.js";
import { sha256 } from "../security/redaction.js";

export interface RepositoryPreflight {
  canonicalRoot: string;
  rootHash: string;
  remotes: Array<{ name: string; urlHash: string; direction: string }>;
  selectedRemote: string | null;
  currentBranch: string;
  head: string;
  defaultBranch: string | null;
  dirtyTracked: string[];
  staged: string[];
  untracked: string[];
  unpushedCommits: number | null;
  upstream: string | null;
  localBranches: Array<{ name: string; head: string; isCurrent: boolean }>;
  worktrees: Array<{ pathHash: string; head: string; branch: string | null }>;
  codeRelayBranches: string[];
  submoduleStatus: string[];
  lfs: { applicable: boolean; available: boolean; outputHash?: string };
  clean: boolean;
  requiresUnpushedConfirmation: boolean;
  capturedAt: string;
}

function parseStatus(raw: string): { dirtyTracked: string[]; staged: string[]; untracked: string[] } {
  const dirtyTracked: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  const entries = raw.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    let file = entry.slice(3);
    if ((code[0] === "R" || code[0] === "C") && entries[index + 1]) {
      file = `${file} -> ${entries[++index]!}`;
    }
    if (code === "??") untracked.push(file);
    else {
      if (code[0] !== " ") staged.push(file);
      if (code[1] !== " " || code[0] === "D") dirtyTracked.push(file);
    }
  }
  return { dirtyTracked: dirtyTracked.sort(), staged: staged.sort(), untracked: untracked.sort() };
}

function parseWorktrees(raw: string): Array<{ pathHash: string; head: string; branch: string | null }> {
  return raw.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? "";
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "";
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7).replace("refs/heads/", "") ?? null;
    return { pathHash: sha256(path.resolve(worktree)), head, branch };
  });
}

export async function inspectRepository(repository: string, gitExecutable: string): Promise<RepositoryPreflight> {
  const bootstrap = new TrustedGit({ executable: gitExecutable, repository });
  const rootOutput = await bootstrap.run(["rev-parse", "--show-toplevel"]);
  const canonicalRoot = await realpath(rootOutput.trim());
  const git = new TrustedGit({ executable: gitExecutable, repository: canonicalRoot });
  const [remoteRaw, branchRaw, headRaw, statusRaw, upstreamRaw, worktreeRaw, codeRelayRaw, submoduleRaw, lfsRaw, lfsAttributesRaw] = await Promise.all([
    git.run(["remote", "-v"]),
    git.run(["branch", "--show-current"]),
    git.run(["rev-parse", "HEAD"]),
    git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], canonicalRoot, true),
    git.run(["worktree", "list", "--porcelain"]),
    git.run(["for-each-ref", "--format=%(refname:short)", "refs/heads/coderelay/"]),
    git.run(["submodule", "status", "--recursive"], canonicalRoot, true),
    git.run(["lfs", "env"], canonicalRoot, true),
    git.run(["grep", "-n", "filter=lfs", "--", ".gitattributes"], canonicalRoot, true)
  ]);
  const remotes = remoteRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
    return match ? { name: match[1]!, urlHash: sha256(match[2]!), direction: match[3]! } : undefined;
  }).filter((entry): entry is { name: string; urlHash: string; direction: string } => Boolean(entry));
  const selectedRemote = remotes.find((remote) => remote.direction === "fetch" && remote.name === "origin")?.name
    ?? remotes.find((remote) => remote.direction === "fetch")?.name ?? null;
  let defaultBranch: string | null = null;
  if (selectedRemote) {
    const symbolic = await git.run(["symbolic-ref", "--short", `refs/remotes/${selectedRemote}/HEAD`], canonicalRoot, true);
    defaultBranch = symbolic.trim().replace(`${selectedRemote}/`, "") || null;
  }
  if (!defaultBranch) defaultBranch = branchRaw.trim() || null;
  const upstream = upstreamRaw.trim() || null;
  let unpushedCommits: number | null = null;
  if (upstream) {
    const count = await git.run(["rev-list", "--count", `${upstream}..HEAD`]);
    unpushedCommits = Number(count.trim());
  }
  const branchListRaw = await git.run(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]);
  const currentBranchName = branchRaw.trim();
  const localBranches = branchListRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.lastIndexOf(" ");
    const name = line.slice(0, separator);
    return { name, head: line.slice(separator + 1), isCurrent: name === currentBranchName };
  }).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name));
  const status = parseStatus(statusRaw);
  const submoduleStatus = submoduleRaw.split(/\r?\n/).filter(Boolean);
  const dirtySubmodule = submoduleStatus.some((line) => /^[+U-]/.test(line));
  const clean = status.dirtyTracked.length === 0 && status.staged.length === 0 && status.untracked.length === 0 && !dirtySubmodule;
  return {
    canonicalRoot,
    rootHash: sha256(canonicalRoot),
    remotes,
    selectedRemote,
    currentBranch: branchRaw.trim(),
    head: headRaw.trim(),
    defaultBranch,
    ...status,
    unpushedCommits,
    upstream,
    localBranches,
    worktrees: parseWorktrees(worktreeRaw),
    codeRelayBranches: codeRelayRaw.split(/\r?\n/).filter(Boolean).sort(),
    submoduleStatus,
    lfs: { applicable: lfsAttributesRaw.trim() !== "", available: lfsRaw.trim() !== "", ...(lfsRaw.trim() ? { outputHash: sha256(lfsRaw) } : {}) },
    clean,
    requiresUnpushedConfirmation: (unpushedCommits ?? 0) > 0 || (selectedRemote !== null && upstream === null),
    capturedAt: new Date().toISOString()
  };
}

export function assertRepositoryMayStart(preflight: RepositoryPreflight, confirmedUnpushed = false): void {
  if (!preflight.clean) throw new Error("PRIMARY_CHECKOUT_DIRTY: staged, tracked, untracked, or submodule changes must be resolved by the user");
  if (preflight.requiresUnpushedConfirmation && !confirmedUnpushed) {
    throw new Error("UNPUSHED_BASE_REQUIRES_CONFIRMATION: CodeRelay will use the recorded local commit without pushing it");
  }
}
