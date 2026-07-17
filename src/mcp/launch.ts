import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface McpServerLaunch {
  command: string;
  args: string[];
  environment: Record<string, string>;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export function builtMcpServerLaunch(cwd = process.cwd()): McpServerLaunch {
  // Compiled layout: dist/src/mcp/launch.js -> dist/mcp-server.mjs.
  // tsx/dev layout falls back to <cwd>/dist/mcp-server.mjs.
  const candidates = [
    path.resolve(moduleDirectory, "..", "..", "mcp-server.mjs"),
    path.resolve(cwd, "dist", "mcp-server.mjs")
  ];
  const server = candidates.find((candidate) => existsSync(candidate));
  if (!server) {
    throw new Error("MCP_SERVER_ARTIFACT_MISSING: run the TypeScript build before provider proofs or real handoffs");
  }
  // When the orchestrator runs inside Electron (packaged app), process.execPath
  // is the Electron binary; ELECTRON_RUN_AS_NODE makes the child run as plain
  // Node. Under a real Node executable the variable is a harmless no-op.
  return { command: process.execPath, args: [server], environment: { ELECTRON_RUN_AS_NODE: "1" } };
}
