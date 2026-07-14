import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildSafeEnvironment } from "../src/security/environment.js";
import { CommandBroker, CommandPolicy, hardDenial } from "../src/security/command-policy.js";
import { PathPolicy, PathPolicyError, applyStructuredPatch } from "../src/security/path-policy.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

describe("allowlisted environment", () => {
  test("omits provider, cloud, and unrelated secrets", () => {
    const safe = buildSafeEnvironment({
      source: { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", MY_TOKEN: "secret" },
      platform: "win32",
      restrictedPath: ["C:\\restricted"],
      tempDirectory: "C:\\temp",
      homeDirectory: "C:\\profile"
    });
    expect(safe.values.SystemRoot).toBe("C:\\Windows");
    expect(safe.values.PATH).toBe("C:\\restricted");
    expect(Object.values(safe.values)).not.toContain("secret");
    expect(Object.keys(safe.values)).not.toContain("OPENAI_API_KEY");
  });
});

describe("command policy", () => {
  test.each([
    ["git.exe", ["push"]],
    ["C:\\Program Files\\Git\\cmd\\git.exe", ["commit", "-m", "x"]],
    ["git", ["-c", "alias.x=!powershell", "x"]],
    ["gh", ["pr", "merge", "42"]],
    ["gcloud", ["run", "deploy"]],
    ["supabase", ["db", "push"]],
    ["terraform", ["apply"]],
    ["kubectl", ["apply", "-f", "x"]],
    ["npm.cmd", ["publish"]],
    ["pnpm", ["publish"]],
    ["powershell.exe", ["-Command", "pwd"]],
    ["bash", ["-c", "pwd"]]
  ])("hard-denies %s %j", (executable, args) => {
    expect(hardDenial({ executable, args })).toMatchObject({ allowed: false });
  });

  test("is default-deny and matches exact rules", () => {
    const policy = new CommandPolicy([{ executable: process.execPath, args: ["--version"], match: "exact" }]);
    expect(policy.decide({ executable: process.execPath, args: ["--version"] }).allowed).toBe(true);
    expect(policy.decide({ executable: path.join(path.dirname(process.execPath), "fake", path.basename(process.execPath)), args: ["--version"] }).allowed).toBe(false);
    expect(policy.decide({ executable: process.execPath, args: ["-e", "console.log(1)"] }).allowed).toBe(false);
  });
});

describe("path and command broker confinement", () => {
  test("rejects traversal, .git, prohibited paths, and link escapes", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "coderelay-security-test-"));
    temporary.push(base);
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "secret"), "secret");
    const policy = new PathPolicy({ root, approvedPaths: ["src"], prohibitedPaths: ["src/no"] });
    await policy.initialize();
    await expect(policy.resolve("../outside/secret", "read")).rejects.toBeInstanceOf(PathPolicyError);
    await expect(policy.resolve(".git/config", "write")).rejects.toBeInstanceOf(PathPolicyError);
    await expect(policy.resolve("src/no/value", "write")).rejects.toBeInstanceOf(PathPolicyError);
    await symlink(outside, path.join(root, "src", "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(policy.resolve("src/escape/secret", "read")).rejects.toMatchObject({ code: "LINK_ESCAPE_RISK" });
  });

  test("applies structured optimistic writes and executes only the exact command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coderelay-broker-test-"));
    temporary.push(root);
    await mkdir(path.join(root, "src"));
    const paths = new PathPolicy({ root, approvedPaths: ["."] });
    const edits = await applyStructuredPatch(paths, [{ path: "src/value.txt", content: "one\n" }]);
    expect(await readFile(path.join(root, "src", "value.txt"), "utf8")).toBe("one\n");
    await expect(applyStructuredPatch(paths, [{ path: "src/value.txt", content: "two\n", expectedSha256: "sha256:wrong" }])).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    const safe = buildSafeEnvironment({ restrictedPath: [path.dirname(process.execPath)], tempDirectory: os.tmpdir(), homeDirectory: root });
    const broker = new CommandBroker(new CommandPolicy([{ executable: process.execPath, args: ["--version"], match: "exact" }]), paths, safe);
    expect((await broker.run({ executable: process.execPath, args: ["--version"], cwd: ".", timeoutMs: 5_000 })).exitCode).toBe(0);
    await expect(broker.run({ executable: process.execPath, args: ["-e", "process.exit()"], cwd: ".", timeoutMs: 5_000 })).rejects.toThrow("DEFAULT_DENY");
    expect(edits[0]?.hash).toMatch(/^sha256:/);
  });
});
