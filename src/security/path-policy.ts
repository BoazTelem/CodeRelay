import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./redaction.js";

export class PathPolicyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export interface PathPolicyOptions {
  root: string;
  approvedPaths: readonly string[];
  prohibitedPaths?: readonly string[];
  platform?: NodeJS.Platform;
}

function comparisonValue(value: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const relative = path.relative(comparisonValue(root, platform), comparisonValue(candidate, platform));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePolicyRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === "" ? "." : normalized;
}

function pathMatchesPrefix(relativePath: string, prefix: string): boolean {
  const value = normalizePolicyRelative(relativePath);
  const normalizedPrefix = normalizePolicyRelative(prefix);
  return normalizedPrefix === "." || value === normalizedPrefix || value.startsWith(`${normalizedPrefix}/`);
}

async function canonicalExistingAncestor(candidate: string, root: string): Promise<{ canonical: string; missing: string[] }> {
  const missing: string[] = [];
  let cursor = candidate;
  while (true) {
    try {
      const canonical = await realpath(cursor);
      return { canonical: path.join(canonical, ...missing.reverse()), missing };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      if (path.normalize(cursor) === path.normalize(root)) throw error;
      missing.push(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

export class PathPolicy {
  private readonly platform: NodeJS.Platform;
  private canonicalRoot: string | undefined;

  constructor(private readonly options: PathPolicyOptions) {
    this.platform = options.platform ?? process.platform;
  }

  async initialize(): Promise<void> {
    this.canonicalRoot = await realpath(this.options.root);
  }

  private async root(): Promise<string> {
    if (!this.canonicalRoot) await this.initialize();
    return this.canonicalRoot!;
  }

  async resolve(relativeInput: string, access: "read" | "write"): Promise<string> {
    if (!relativeInput || path.isAbsolute(relativeInput)) {
      throw new PathPolicyError("Only non-empty relative paths are accepted", "ABSOLUTE_OR_EMPTY_PATH");
    }
    if (this.platform === "win32" && relativeInput.includes(":")) {
      throw new PathPolicyError("Windows alternate data streams and device paths are forbidden", "WINDOWS_SPECIAL_PATH");
    }
    const policyRelative = normalizePolicyRelative(relativeInput);
    const segments = policyRelative.split("/");
    if (segments.some((segment) => segment === ".." || segment.toLowerCase() === ".git")) {
      throw new PathPolicyError("Traversal and .git access are forbidden", "PROHIBITED_SEGMENT");
    }
    if (!this.options.approvedPaths.some((approved) => pathMatchesPrefix(policyRelative, approved))) {
      throw new PathPolicyError("Path is outside approved paths", "PATH_NOT_APPROVED");
    }
    if ((this.options.prohibitedPaths ?? []).some((prohibited) => pathMatchesPrefix(policyRelative, prohibited))) {
      throw new PathPolicyError("Path is prohibited by project policy", "PATH_PROHIBITED");
    }

    const canonicalRoot = await this.root();
    const lexical = path.resolve(canonicalRoot, relativeInput);
    if (!isInside(canonicalRoot, lexical, this.platform)) {
      throw new PathPolicyError("Path escapes the isolated worktree", "PATH_ESCAPE");
    }

    const parts = path.relative(canonicalRoot, lexical).split(path.sep).filter(Boolean);
    let cursor = canonicalRoot;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) {
          throw new PathPolicyError("Symbolic links, junctions, and reparse-point aliases are forbidden", "LINK_ESCAPE_RISK");
        }
      } catch (error) {
        if (error instanceof PathPolicyError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }

    const { canonical } = await canonicalExistingAncestor(lexical, canonicalRoot);
    if (!isInside(canonicalRoot, canonical, this.platform)) {
      throw new PathPolicyError("Canonical path escapes the isolated worktree", "CANONICAL_ESCAPE");
    }
    if (access === "read") {
      try {
        await lstat(lexical);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new PathPolicyError("Read target does not exist", "NOT_FOUND");
        }
        throw error;
      }
    }
    return lexical;
  }

  async assertDirectory(relativeInput: string): Promise<string> {
    const resolved = await this.resolve(relativeInput, "read");
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new PathPolicyError("Command cwd must be a directory", "NOT_DIRECTORY");
    return resolved;
  }
}

export interface FileEdit {
  path: string;
  content: string | null;
  expectedSha256?: string;
}

export async function applyStructuredPatch(policy: PathPolicy, edits: readonly FileEdit[]): Promise<Array<{ path: string; hash: string | null }>> {
  if (edits.length === 0 || edits.length > 100) throw new PathPolicyError("Patch must contain 1-100 edits", "PATCH_SIZE");
  const prepared: Array<{ edit: FileEdit; target: string }> = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (seen.has(edit.path)) throw new PathPolicyError("A patch cannot edit the same path twice", "DUPLICATE_EDIT");
    seen.add(edit.path);
    if (edit.content !== null && Buffer.byteLength(edit.content, "utf8") > 2 * 1024 * 1024) {
      throw new PathPolicyError("A single edit exceeds 2 MiB", "EDIT_TOO_LARGE");
    }
    const target = await policy.resolve(edit.path, "write");
    if (edit.expectedSha256) {
      let current = "";
      try {
        current = await import("node:fs/promises").then(({ readFile }) => readFile(target, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (sha256(current) !== edit.expectedSha256) throw new PathPolicyError("Expected content hash does not match", "HASH_MISMATCH");
    }
    prepared.push({ edit, target });
  }
  const results: Array<{ path: string; hash: string | null }> = [];
  for (const { edit, target } of prepared) {
    if (edit.content === null) {
      await rm(target, { force: true });
      results.push({ path: edit.path, hash: null });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await policy.resolve(edit.path, "write");
    const temporary = `${target}.coderelay-${randomUUID()}.tmp`;
    await writeFile(temporary, edit.content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    results.push({ path: edit.path, hash: sha256(edit.content) });
  }
  return results;
}
