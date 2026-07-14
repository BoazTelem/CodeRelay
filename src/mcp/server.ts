#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { BrokerConfig } from "./config.js";
import { sha256 } from "../security/redaction.js";
import { PathPolicy, applyStructuredPatch } from "../security/path-policy.js";
import { CommandBroker, CommandPolicy } from "../security/command-policy.js";
import { buildSafeEnvironment } from "../security/environment.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function loadConfiguration(): Promise<{ config: BrokerConfig; paths: PathPolicy; broker: CommandBroker }> {
  const configPath = argument("--config");
  const nonce = argument("--nonce");
  const config = BrokerConfig.parse(JSON.parse(await readFile(configPath, "utf8")));
  if (sha256(nonce) !== config.capabilityNonceHash) throw new Error("Capability nonce mismatch");
  if (Date.parse(config.expiresAt) <= Date.now()) throw new Error("Capability expired");
  const paths = new PathPolicy({ root: config.root, approvedPaths: config.approvedPaths, prohibitedPaths: config.prohibitedPaths });
  await paths.initialize();
  const environment = buildSafeEnvironment({
    restrictedPath: config.restrictedPath,
    tempDirectory: config.tempDirectory,
    ...(config.homeDirectory ? { homeDirectory: config.homeDirectory } : {})
  });
  const broker = new CommandBroker(new CommandPolicy(config.commandRules), paths, environment);
  return { config, paths, broker };
}

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function main(): Promise<void> {
  const { config, paths, broker } = await loadConfiguration();
  const server = new McpServer({ name: "coderelay-restricted-tools", version: "1.0.0" });

  server.registerTool("read_file", {
    description: "Read a UTF-8 file inside approved Work Item paths.",
    inputSchema: { path: z.string().min(1) }
  }, async ({ path: relativePath }) => {
    const resolved = await paths.resolve(relativePath, "read");
    const info = await lstat(resolved);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("File must be a regular UTF-8 file no larger than 2 MiB");
    const content = await readFile(resolved, "utf8");
    return response({ path: relativePath, content, hash: sha256(content) });
  });

  server.registerTool("list_files", {
    description: "List approved files without following links.",
    inputSchema: { path: z.string().min(1).default("."), maxEntries: z.number().int().min(1).max(2_000).default(500) }
  }, async ({ path: relativePath, maxEntries }) => {
    const base = await paths.resolve(relativePath, "read");
    const results: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (results.length >= maxEntries) return;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(config.root, absolute).replaceAll("\\", "/");
        await paths.resolve(relative, "read");
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) results.push(relative);
      }
    };
    const info = await lstat(base);
    if (info.isDirectory()) await visit(base); else results.push(relativePath);
    return response({ files: results.sort(), truncated: results.length >= maxEntries });
  });

  server.registerTool("search", {
    description: "Literal UTF-8 search inside approved files.",
    inputSchema: { query: z.string().min(1).max(500), paths: z.array(z.string().min(1)).min(1).max(200), maxMatches: z.number().int().min(1).max(1_000).default(200) }
  }, async ({ query, paths: requestedPaths, maxMatches }) => {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const requestedPath of requestedPaths) {
      if (matches.length >= maxMatches) break;
      const resolved = await paths.resolve(requestedPath, "read");
      const info = await lstat(resolved);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
      const lines = (await readFile(resolved, "utf8")).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (matches.length < maxMatches && line.includes(query)) matches.push({ path: requestedPath, line: index + 1, text: line.slice(0, 1_000) });
      });
    }
    return response({ matches, truncated: matches.length >= maxMatches });
  });

  server.registerTool("apply_patch", {
    description: "Apply structured whole-file writes/deletes inside approved paths with optional optimistic hashes.",
    inputSchema: {
      edits: z.array(z.object({ path: z.string().min(1), content: z.string().nullable(), expectedSha256: z.string().optional() })).min(1).max(100)
    }
  }, async ({ edits }) => response({ edits: await applyStructuredPatch(paths, edits.map((edit) => ({
    path: edit.path,
    content: edit.content,
    ...(edit.expectedSha256 !== undefined ? { expectedSha256: edit.expectedSha256 } : {})
  }))) }));

  server.registerTool("run_command", {
    description: "Run one exact allowlisted executable and argument array without a shell.",
    inputSchema: {
      executable: z.string().min(1),
      args: z.array(z.string()).max(100),
      cwd: z.string().min(1).default("."),
      timeoutMs: z.number().int().min(1).max(30 * 60 * 1_000).default(120_000)
    }
  }, async (request) => response(await broker.run(request)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`CodeRelay MCP bridge ready for ${config.workItemId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
