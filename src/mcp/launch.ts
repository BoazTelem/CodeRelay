import { existsSync } from "node:fs";
import path from "node:path";

export interface McpServerLaunch {
  command: string;
  args: string[];
}

export function builtMcpServerLaunch(cwd = process.cwd()): McpServerLaunch {
  const server = path.resolve(cwd, "dist", "mcp-server.mjs");
  if (!existsSync(server)) {
    throw new Error("MCP_SERVER_ARTIFACT_MISSING: run the TypeScript build before provider proofs or real handoffs");
  }
  return { command: process.execPath, args: [server] };
}
