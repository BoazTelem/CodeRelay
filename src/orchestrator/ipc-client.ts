import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, UtilityResponse, type UtilityRequest } from "../contracts/schemas.js";

export class UtilityProcessClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<string, { resolve: (value: UtilityResponse) => void; reject: (error: Error) => void }>();
  private stderr = "";

  constructor(dataDirectory: string) {
    const script = fileURLToPath(new URL("./utility-process.ts", import.meta.url));
    const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    this.child = spawn(process.execPath, ["--import", tsxLoader, script, "--data-dir", dataDirectory], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => { this.child.once("exit", () => resolve()); });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const response = UtilityResponse.parse(JSON.parse(line));
        const waiter = this.pending.get(response.requestId);
        if (waiter) { this.pending.delete(response.requestId); waiter.resolve(response); }
      } catch (error) {
        for (const waiter of this.pending.values()) waiter.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.clear();
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.once("exit", (code) => {
      if (code !== 0) {
        for (const waiter of this.pending.values()) waiter.reject(new Error(`Utility exited ${code}: ${this.stderr}`));
        this.pending.clear();
      }
    });
  }

  request(method: UtilityRequest["method"], payload: unknown = {}, idempotencyKey: string = randomUUID()): Promise<UtilityResponse> {
    const requestId = randomUUID();
    const correlationId = randomUUID();
    const request: UtilityRequest = { schemaVersion: SCHEMA_VERSION, requestId, correlationId, idempotencyKey, method, payload };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => { if (error) { this.pending.delete(requestId); reject(error); } });
    });
  }

  async close(): Promise<void> {
    if (!this.child.killed) {
      await this.request("shutdown");
      this.child.stdin.end();
      await this.exited;
    }
  }
}
