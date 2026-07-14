import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../src/security/redaction.js";
import { builtMcpServerLaunch } from "../src/mcp/launch.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("restricted MCP server contract", () => {
  test("publishes complete object input schemas for every broker tool", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "coderelay-mcp-contract-"));
    temporaryDirectories.push(temporary);
    const root = path.join(temporary, "worktree");
    await mkdir(path.join(root, "src"), { recursive: true });
    const nonce = "mcp-contract-nonce";
    const configPath = path.join(temporary, "broker.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: "1.0.0",
      workItemId: "mcp-contract",
      capabilityNonceHash: sha256(nonce),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      root,
      approvedPaths: ["src"],
      prohibitedPaths: [".git"],
      commandRules: [],
      restrictedPath: [path.dirname(process.execPath)],
      tempDirectory: temporary,
      homeDirectory: os.homedir()
    }), "utf8");

    const server = builtMcpServerLaunch();
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: server.command,
      args: [...server.args, "--config", configPath, "--nonce", nonce],
      cwd: root,
      env: environment,
      stderr: "pipe"
    });
    const client = new Client({ name: "coderelay-contract-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "apply_patch", "list_files", "read_file", "run_command", "search"
      ]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type, tool.name).toBe("object");
        expect(tool.inputSchema.properties, tool.name).toBeTypeOf("object");
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
