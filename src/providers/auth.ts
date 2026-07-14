import type { AuthenticationProof, ProviderAuthState } from "../contracts/schemas.js";
import type { CapturedProcess } from "../platform/services.js";
import { observedFieldNames, redactObject, redactText, sha256 } from "../security/redaction.js";

function proof(
  state: ProviderAuthState,
  command: string[],
  result: CapturedProcess,
  fields: string[] = [],
  stdoutOverride?: string
): AuthenticationProof {
  const stdout = stdoutOverride ?? redactText(result.stdout);
  const stderr = redactText(result.stderr);
  return {
    state,
    command,
    exitCode: result.exitCode,
    observedFieldNames: fields,
    stdoutRedacted: stdout,
    stderrRedacted: stderr,
    evidenceHash: sha256(JSON.stringify({ state, command, exitCode: result.exitCode, stdout, stderr, fields })),
    probedAt: new Date().toISOString()
  };
}

export function normalizeCodexAuthentication(result: CapturedProcess): AuthenticationProof {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.spawnError || /not recognized|not found|access is denied|enoent/i.test(combined)) {
    return proof("PROVIDER_UNAVAILABLE", ["login", "status"], result);
  }
  if (result.exitCode !== 0 && /not logged in|login required|please login|unauthenticated/i.test(combined)) {
    return proof("NOT_AUTHENTICATED", ["login", "status"], result);
  }
  if (/api[ _-]?key|api billing|metered api|openai_api_key/i.test(combined)) {
    return proof("API_BILLING_DETECTED", ["login", "status"], result);
  }
  if (result.exitCode === 0 && /logged in (?:with|using|via) chatgpt|authentication method\s*:\s*chatgpt/i.test(combined)) {
    return proof("SUBSCRIPTION_VERIFIED", ["login", "status"], result);
  }
  if (result.exitCode === 0 && /logged in|authenticated|authentication method/i.test(combined)) {
    return proof("AUTHENTICATED_BUT_MODE_UNKNOWN", ["login", "status"], result);
  }
  return proof(result.exitCode === 0 ? "AUTHENTICATED_BUT_MODE_UNKNOWN" : "NOT_AUTHENTICATED", ["login", "status"], result);
}

const SUBSCRIPTION_TYPES = new Set(["pro", "max", "team", "enterprise", "claude pro", "claude max", "claude team", "claude enterprise"]);

function stringFields(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(stringFields);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringFields);
  return typeof value === "string" ? [value.toLowerCase()] : [];
}

export function normalizeClaudeAuthentication(result: CapturedProcess): AuthenticationProof {
  if (result.spawnError) return proof("PROVIDER_UNAVAILABLE", ["auth", "status"], result);
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || /not logged in|login required|unauthenticated/i.test(combined)) {
      return proof("NOT_AUTHENTICATED", ["auth", "status"], result);
    }
    return proof("AUTHENTICATED_BUT_MODE_UNKNOWN", ["auth", "status"], result);
  }
  const fields = observedFieldNames(parsed);
  const redacted = JSON.stringify(redactObject(parsed));
  const values = stringFields(parsed);
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const loggedIn = record.loggedIn ?? record.authenticated ?? record.isAuthenticated;
  if (loggedIn === false || result.exitCode === 1) return proof("NOT_AUTHENTICATED", ["auth", "status"], result, fields, redacted);
  const hasApiBilling = values.some((value) => /console|api key|api billing|bedrock|vertex|foundry/.test(value));
  if (hasApiBilling) return proof("API_BILLING_DETECTED", ["auth", "status"], result, fields, redacted);
  const subscriptionValue = values.find((value) => SUBSCRIPTION_TYPES.has(value) || /^claude (pro|max|team|enterprise)/.test(value));
  if (loggedIn === true && subscriptionValue) return proof("SUBSCRIPTION_VERIFIED", ["auth", "status"], result, fields, redacted);
  if (loggedIn === true || result.exitCode === 0) return proof("AUTHENTICATED_BUT_MODE_UNKNOWN", ["auth", "status"], result, fields, redacted);
  return proof("NOT_AUTHENTICATED", ["auth", "status"], result, fields, redacted);
}

