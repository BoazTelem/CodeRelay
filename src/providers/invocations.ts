export interface RestrictedInvocation {
  executable: string;
  args: string[];
}

export interface CodexInvocationOptions {
  executable: string;
  access: "read-only" | "workspace-write";
  prompt: string;
  schemaPath: string;
  outputPath: string;
  mcpConfigOverrides: string[];
  resume?: { mode: "id"; value: string } | { mode: "latest" };
}

export function buildCodexRestrictedInvocation(options: CodexInvocationOptions): RestrictedInvocation {
  const global = [
    // The provider process itself remains read-only. All scoped writes go through
    // the separately policy-enforced CodeRelay MCP bridge.
    "--sandbox", "read-only",
    "--disable", "shell_tool",
    "--disable", "unified_exec",
    "--disable", "browser_use",
    "--disable", "remote_plugin",
    "--disable", "apps",
    "--disable", "hooks",
    "--disable", "goals",
    "--disable", "multi_agent",
    "--disable", "memories",
    "--disable", "shell_snapshot",
    "-c", "project_doc_max_bytes=0",
    "-c", "project_doc_fallback_filenames=[]",
    "-c", "web_search=\"disabled\"",
    ...options.mcpConfigOverrides
  ];
  const exec = options.resume
    ? ["exec", "resume", ...(options.resume.mode === "latest" ? ["--last"] : [options.resume.value])]
    : ["exec"];
  return {
    executable: options.executable,
    args: [
      ...global,
      ...exec,
      // These are exec/exec-resume flags in current native Codex builds, not
      // root CLI flags. Keeping them after the subcommand is security-critical:
      // a rejected isolation flag must fail before a provider turn starts.
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--output-schema", options.schemaPath,
      "-o", options.outputPath,
      options.prompt
    ]
  };
}

export interface ClaudeInvocationOptions {
  executable: string;
  prompt?: string;
  schemaJson: string;
  mcpConfigPath: string;
  mcpEnabled: boolean;
  resume?: { mode: "id-or-name"; value: string } | { mode: "latest" };
}

export function buildClaudeRestrictedInvocation(options: ClaudeInvocationOptions): RestrictedInvocation {
  const resume = options.resume
    ? options.resume.mode === "latest" ? ["--continue"] : ["--resume", options.resume.value]
    : [];
  return {
    executable: options.executable,
    args: [
      "--print",
      // Current Claude builds suppress even an explicitly supplied MCP server
      // under --safe-mode. Worker turns instead load no user/project/local
      // settings and admit only the Work-Item-scoped CodeRelay MCP server.
      ...(options.mcpEnabled ? ["--setting-sources", ""] : ["--safe-mode"]),
      "--strict-mcp-config",
      "--mcp-config", options.mcpConfigPath,
      "--disable-slash-commands",
      "--no-chrome",
      "--tools", "",
      ...(options.mcpEnabled ? [
        "--allowedTools",
        "mcp__coderelay__read_file,mcp__coderelay__list_files,mcp__coderelay__search,mcp__coderelay__apply_patch,mcp__coderelay__run_command"
      ] : []),
      "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
      "--permission-mode", "dontAsk",
      "--output-format", "stream-json",
      "--verbose",
      "--include-hook-events",
      "--json-schema", options.schemaJson,
      ...resume,
      ...(options.prompt === undefined ? [] : [options.prompt])
    ]
  };
}
