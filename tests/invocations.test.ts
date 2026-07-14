import { describe, expect, test } from "vitest";
import { buildClaudeRestrictedInvocation, buildCodexRestrictedInvocation } from "../src/providers/invocations.js";
import { buildProviderJsonSchema, summarizeProviderFailure } from "../src/providers/real-adapter.js";
import { WorkerResult } from "../src/contracts/schemas.js";

describe("restricted provider invocations", () => {
  test("keeps the Codex process read-only and disables inherited execution/customization surfaces", () => {
    const invocation = buildCodexRestrictedInvocation({
      executable: "codex.exe", access: "workspace-write", prompt: "-", schemaPath: "schema.json", outputPath: "output.json",
      mcpConfigOverrides: ["-c", "mcp_servers.coderelay.required=true"]
    });
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--ignore-user-config", "--sandbox", "read-only", "--disable", "shell_tool", "--disable", "unified_exec",
      "-c", "project_doc_max_bytes=0", "--ignore-rules", "--json", "--output-schema", "schema.json"
    ]));
    expect(invocation.args).not.toContain("--cloud");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args.indexOf("exec")).toBeLessThan(invocation.args.indexOf("--ignore-user-config"));
    expect(invocation.args.indexOf("exec")).toBeLessThan(invocation.args.indexOf("--ignore-rules"));
  });

  test("places Codex exec-resume isolation flags after the nested subcommand", () => {
    const invocation = buildCodexRestrictedInvocation({
      executable: "codex.exe", access: "read-only", prompt: "-", schemaPath: "schema.json", outputPath: "output.json",
      mcpConfigOverrides: [], resume: { mode: "id", value: "session-id" }
    });
    const resume = invocation.args.indexOf("resume");
    expect(resume).toBeGreaterThan(invocation.args.indexOf("exec"));
    expect(invocation.args.indexOf("--ignore-user-config")).toBeGreaterThan(resume);
    expect(invocation.args.indexOf("--ignore-rules")).toBeGreaterThan(resume);
  });

  test("uses Claude safe mode, strict MCP, no built-ins, no browser, and no cloud fallback", () => {
    const invocation = buildClaudeRestrictedInvocation({
      executable: "claude.exe", schemaJson: "{}", mcpConfigPath: "mcp.json", mcpEnabled: false
    });
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--print", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--tools", "",
      "--permission-mode", "dontAsk", "--json-schema", "{}"
    ]));
    expect(invocation.args).not.toContain("--cloud");
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
  });

  test("uses an empty-settings MCP-only profile for Claude Worker turns", () => {
    const invocation = buildClaudeRestrictedInvocation({
      executable: "claude.exe", schemaJson: "{}", mcpConfigPath: "mcp.json", mcpEnabled: true
    });
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--allowedTools",
      "mcp__coderelay__read_file,mcp__coderelay__list_files,mcp__coderelay__search,mcp__coderelay__apply_patch,mcp__coderelay__run_command"
    ]));
    expect(invocation.args).not.toContain("--safe-mode");
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
  });

  test("summarizes JSONL provider failures without leaking identity, paths, or tokens", () => {
    const summary = summarizeProviderFailure({
      exitCode: 1,
      stderr: "",
      stdout: `${JSON.stringify({
        type: "result", subtype: "error_during_execution", is_error: true,
        result: "Failure for person@example.com at C:\\Users\\person\\secret.txt with Bearer abc.def"
      })}\n`
    });
    expect(summary).toContain("error_during_execution");
    expect(summary).toContain("[REDACTED_EMAIL]");
    expect(summary).toContain("[REDACTED_PATH]");
    expect(summary).toContain("Bearer [REDACTED]");
    expect(summary).not.toContain("person@example.com");
    expect(summary).not.toContain("secret.txt");
    expect(summary).not.toContain("abc.def");
  });

  test("generates provider output schemas with a direct top-level object", () => {
    const schema = buildProviderJsonSchema(WorkerResult);
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("$ref");
    expect(schema).not.toHaveProperty("definitions");
    expect(schema.properties).toBeTypeOf("object");
  });
});
