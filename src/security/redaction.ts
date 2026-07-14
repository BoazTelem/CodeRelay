import { createHash } from "node:crypto";

const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|credential|cookie)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH)[A-Z0-9_]*)\s*[=:]\s*([^\s,;]+)/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function redactText(value: string, knownSecrets: readonly string[] = []): string {
  let output = value
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(KEY_VALUE, "$1=[REDACTED]")
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(UUID, "[REDACTED_ID]");
  for (const secret of knownSecrets) {
    if (secret.length >= 4) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

export function redactObject(value: unknown, knownSecrets: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactObject(entry, knownSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactObject(entry, knownSecrets)
    ]));
  }
  return typeof value === "string" ? redactText(value, knownSecrets) : value;
}

export function observedFieldNames(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const fields: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    fields.push(current);
    fields.push(...observedFieldNames(entry, current));
  }
  return fields.sort();
}
