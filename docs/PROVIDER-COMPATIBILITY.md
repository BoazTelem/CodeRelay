# Provider Compatibility

**Matrix version:** 1.0.0-proof  
**Status:** normative, populated by capability proof rather than version assumption

## 1. Policy

Provider support is capability-probed on the executing machine. Version thresholds are hints only. A compatible version that cannot demonstrate the required authentication, restricted configuration, structured output, session behavior, cancellation, and tool confinement is rejected. Raw output is redacted into fixtures; parsers fail closed on unknown formats.

## 2. Required capabilities

| Capability | Codex proof target | Claude proof target | Required for real Work Item |
|---|---|---|---|
| Executable | resolved native `codex`/`codex.exe`, version | resolved native `claude`/Windows launcher, version | yes |
| Subscription auth | `codex login status` normalized without API mode | `claude auth status` JSON normalized as Claude subscription, not Console/API billing | yes |
| Structured output | noninteractive JSONL plus supplied output schema | print/stream JSON plus `--json-schema` | yes |
| New session | noninteractive start with captured ID | print-mode start with captured ID | yes |
| Resume exact ID | `exec resume <id>` | `--resume <id>` | yes when used |
| Resume name | capability-probed command behavior | `--resume <name>` when supported | optional entry point |
| Latest | `exec resume --last` scoped/verified for repo | `--continue`/latest behavior scoped/verified | optional entry point |
| User config isolation | `exec --ignore-user-config` proof | tool-free `--safe-mode`; Worker empty setting sources plus adversarial marker proof | yes |
| Repository instruction suppression | project-doc suppression marker proof | safe-mode or empty-setting-sources marker proof | yes |
| Tool restriction | shell/unified exec/web/plugins disabled; only broker MCP | strict MCP, slash disabled, explicit broker-only tools | yes |
| Sandbox | read-only provider plus separately scoped broker write | safe mode for tool-free turns; empty settings plus broker-only tools for Worker turns | yes |
| Cancellation | graceful signal and verified tree termination | graceful signal and verified tree termination | yes |

Claude structured-output behavior is probed rather than trusted solely from a nominal 2.1.205 minimum. Codex feature/config keys are probed because names and stability can change.

## 3. Normalized capability example

```json
{
  "schemaVersion": "1.0.0",
  "provider": "codex",
  "platform": "win32-x64",
  "executable": { "available": true, "resolvedPathHash": "sha256:example", "version": "example" },
  "authentication": { "command": ["login", "status"], "state": "SUBSCRIPTION_VERIFIED", "exitCode": 0, "observedFieldNames": [], "stdoutRedacted": "Logged in using ChatGPT", "stderrRedacted": "", "evidenceHash": "sha256:example", "probedAt": "2026-01-01T00:00:00.000Z" },
  "structuredOutput": { "supported": true, "schemaEnforced": true, "evidenceRef": "proof:structured" },
  "resume": { "exactId": true, "name": false, "latest": true, "nativePicker": true },
  "customizationIsolation": { "supported": true, "repositoryInstructionsSuppressed": true, "managedPolicyMayApply": false, "evidenceRef": "proof:isolation" },
  "toolRestriction": { "supported": true, "brokerOnly": true, "evidenceRef": "proof:tools" },
  "sandboxing": { "readOnly": true, "workspaceWrite": true, "outsideWorktreeDenied": true, "evidenceRef": "proof:sandbox" },
  "cancellation": { "graceful": true, "processTree": true, "evidenceRef": "proof:cancellation" },
  "knownIncompatibilities": [],
  "probedAt": "2026-01-01T00:00:00.000Z"
}
```

## 4. Authentication normalization

Adapters parse only versioned, captured fixtures. Positive subscription classification requires explicit provider evidence documented by the current probe; absence of an API key is not subscription proof. Any explicit API key, API billing, Console billing, alternate endpoint, cloud provider, or ambiguous authenticated state prevents a Work Item.

Error fingerprints normalize missing executable, permission denied, not authenticated, login required, subscription/quota exhaustion, rate limit, unsupported flag, schema rejection, network outage, provider outage, cancellation, and timeout. Subscription exhaustion maps to `PROVIDER_UNAVAILABLE` and pauses; it does not cause authentication fallback.

## 5. Restricted invocations under proof

Codex proof candidates use the official noninteractive surface with `--ignore-user-config`, an explicit sandbox, `--json`, `--output-schema`, feature/config overrides that suppress project instructions and direct execution/web features, a temporary restricted config home if necessary, and only the CodeRelay MCP server. In Restricted Mode, the provider process remains `read-only`; the logical Worker's `workspace-write` permission is held by the separately policy-enforced MCP bridge. Milestone 0 still capability-probes Codex `workspace-write`, but CodeRelay does not grant it while a built-in mutation path could bypass the broker. Exact accepted flags and effective behavior must be recorded by Milestone 0.

Claude tool-free proof candidates use `--safe-mode`. Claude Worker proof candidates use an empty `--setting-sources` value because version 2.1.209 suppresses explicit MCP under safe mode; they combine `--strict-mcp-config`, the single generated CodeRelay MCP configuration, disabled slash commands and Chrome, an empty built-in `--tools` set, an explicit five-tool CodeRelay `--allowedTools` list, structured output/schema flags, and new/resume selectors. Milestone 0 must prove that no inherited instructions, hooks, plugins, agents, browser tools, built-ins, or unrelated MCP servers appear. Exact JSON fields and minimum effective version are recorded in the redacted local proof.

Current proven Windows proof versions are Codex 0.144.4 and Claude Code 2.1.209. Compatibility remains capability-driven rather than version-only. Provider output schemas must contain a direct top-level object type, and the bundled MCP utility artifact must complete its handshake before a Worker turn begins.

No candidate invocation may include Codex cloud tasks, Claude `--cloud`, an API key, or an alternate billing fallback.

## 6. Platform abstraction

`PlatformServices` discovers executables without assuming file extensions, normalizes Windows and POSIX paths, represents shells without handing providers arbitrary shell text, selects `%APPDATA%`/`%LOCALAPPDATA%` versus `~/Library/Application Support`, performs permission and link/reparse checks, and terminates verified process trees using platform-specific implementations.

Milestones 0–2 implement and certify Windows first. macOS Intel/Apple Silicon adapters and parity tests begin only after `GO`; the contracts must remain platform-neutral from the first commit.

## 7. Local proof record

`npm run probe` writes a redacted machine-local record under ignored `evidence/local/` and optionally a reviewed fixture under `evidence/fixtures/`. It includes OS/architecture, discovery aliases, hashed resolved paths, CLI versions, redacted stdout/stderr, exit status, observed JSON field names, normalized state, feature probes, security-probe decisions, and timestamps. It never includes tokens, raw session IDs, environment values, or repository source.
