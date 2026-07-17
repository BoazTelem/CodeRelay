# Tracking: Claude subscription usage percentages

**Status:** waiting on upstream  
**Upstream request:** <https://github.com/anthropics/claude-code/issues/78476> (filed 2026-07-17)

CodeRelay shows remaining-quota bars for Codex (parsed from the Codex CLI's own
session rollout `rate_limits` snapshots) but can only show status + reset time
for Claude: the headless `rate_limit_event` carries no utilization numbers, and
the percentages in the interactive `/usage` screen come from the authenticated
`/api/oauth/usage` endpoint, which CodeRelay must not call — the security model
forbids reading or using provider credentials.

When Claude Code exposes utilization headlessly (fields in `rate_limit_event`
or a `claude usage --json` command), extend `normalizeClaudeRateLimitEvent` in
[`src/providers/usage.ts`](../../src/providers/usage.ts) to populate `windows`,
and the existing UI will render the same remaining-quota bars it does for
Codex with no further changes.
