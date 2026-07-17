import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { UtilityRequest, UtilityResponse, SCHEMA_VERSION } from "../contracts/schemas.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface UtilityProcessClientOptions {
  entryScript: string;
  dataDirectory: string;
  onLog?: (line: string) => void;
}

/**
 * Supervises the orchestration utility as a Node child of Electron main
 * (ELECTRON_RUN_AS_NODE) speaking the validated JSONL request protocol.
 * Electron's utilityProcess.fork does not expose a writable stdin, which the
 * JSONL protocol requires, so a Node child is used instead.
 */
export class UtilityProcessClient {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, Pending>();
  private exited = false;
  private exitReason = "not started";

  constructor(private readonly options: UtilityProcessClientOptions) {}

  start(): void {
    const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    this.child = spawn(process.execPath, [this.options.entryScript, "--data-dir", this.options.dataDirectory], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.exited = false;
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    const errors = createInterface({ input: this.child.stderr!, crlfDelay: Infinity });
    errors.on("line", (line) => this.options.onLog?.(`utility: ${line}`));
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitReason = `utility exited (code ${code ?? "null"}, signal ${signal ?? "none"})`;
      for (const [, entry] of this.pending) entry.reject(new Error(this.exitReason));
      this.pending.clear();
    });
  }

  get alive(): boolean {
    return this.child !== undefined && !this.exited;
  }

  async request(method: UtilityRequest["method"], payload: unknown = {}): Promise<unknown> {
    if (!this.alive) throw new Error(`ORCHESTRATOR_UNAVAILABLE: ${this.exitReason}`);
    const requestId = randomUUID();
    const request = UtilityRequest.parse({
      schemaVersion: SCHEMA_VERSION,
      requestId,
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      method,
      payload
    });
    return await new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child!.stdin!.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.pending.delete(requestId);
          reject(error);
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    if (!this.alive) return;
    await this.request("shutdown").catch(() => undefined);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private receive(line: string): void {
    let response;
    try { response = UtilityResponse.parse(JSON.parse(line)); }
    catch { this.options.onLog?.(`utility (unparsed): ${line.slice(0, 500)}`); return; }
    const entry = this.pending.get(response.requestId);
    if (!entry) return;
    this.pending.delete(response.requestId);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new Error(response.error?.message ?? "UTILITY_REQUEST_FAILED"));
  }
}
