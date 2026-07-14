import path from "node:path";
import { sha256 } from "./redaction.js";

const WINDOWS_ALLOWED = new Set([
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "LANG", "LC_ALL", "TZ"
]);
const POSIX_ALLOWED = new Set(["TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]);

const FORBIDDEN_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|CREDENTIAL|AWS_|AZURE_|GOOGLE_|GCP_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|BASE_URL|ENDPOINT|PROXY|SSH_AUTH_SOCK|GITHUB_|GITLAB_|CI_JOB)/i;

export interface EnvironmentOptions {
  platform?: NodeJS.Platform;
  restrictedPath: readonly string[];
  tempDirectory: string;
  homeDirectory?: string;
  source?: NodeJS.ProcessEnv;
  extraAllowedNames?: readonly string[];
}

export interface SafeEnvironment {
  values: NodeJS.ProcessEnv;
  includedNames: string[];
  omittedNames: string[];
  digest: string;
}

export function buildSafeEnvironment(options: EnvironmentOptions): SafeEnvironment {
  const platform = options.platform ?? process.platform;
  const source = options.source ?? process.env;
  const allowed = new Set(platform === "win32" ? WINDOWS_ALLOWED : POSIX_ALLOWED);
  for (const name of options.extraAllowedNames ?? []) allowed.add(name.toUpperCase());
  const values: NodeJS.ProcessEnv = {};
  const includedNames: string[] = [];
  const omittedNames: string[] = [];

  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toUpperCase();
    if (value !== undefined && allowed.has(normalized) && !FORBIDDEN_NAME.test(normalized)) {
      values[name] = value;
      includedNames.push(name);
    } else {
      omittedNames.push(name);
    }
  }

  values.PATH = options.restrictedPath.join(path.delimiter);
  values.TEMP = options.tempDirectory;
  values.TMP = options.tempDirectory;
  if (platform !== "win32") values.TMPDIR = options.tempDirectory;
  if (options.homeDirectory) {
    if (platform === "win32") values.USERPROFILE = options.homeDirectory;
    else values.HOME = options.homeDirectory;
  }
  includedNames.push("PATH", "TEMP", "TMP");
  if (platform !== "win32") includedNames.push("TMPDIR");
  if (options.homeDirectory) includedNames.push(platform === "win32" ? "USERPROFILE" : "HOME");

  const stable = Object.entries(values).map(([key, value]) => `${key}=${sha256(value ?? "")}`).sort().join("\n");
  return {
    values,
    includedNames: [...new Set(includedNames)].sort(),
    omittedNames: [...new Set(omittedNames)].sort(),
    digest: sha256(stable)
  };
}

export function isForbiddenEnvironmentName(name: string): boolean {
  return FORBIDDEN_NAME.test(name);
}

