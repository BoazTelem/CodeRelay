# Security Policy

## Reporting

Do not open a public issue for a suspected vulnerability. Send a private GitHub security advisory to the repository maintainers with reproduction details, affected versions, and impact. Maintainers will acknowledge receipt within seven days.

## Supported state

CodeRelay has no production release yet. Only the current default branch receives security fixes during the proof phase.

## Security invariants

- API or metered billing authentication is rejected; unknown authentication fails closed.
- Provider processes receive an allowlisted environment and Work-Item-scoped tools.
- Provider commands are default-deny and cannot push, merge, deploy, migrate, publish, or commit.
- Provider writes are confined to approved paths in an isolated Git worktree.
- Provider credentials remain owned by official CLIs and are never stored by CodeRelay.
- Public CI uses stubs only and must never contain personal subscription credentials.

Repository secret scanning and push protection should be enabled in GitHub settings. CI also runs dependency review, CodeQL, and a secret scanner. Security boundaries are specified in `docs/SECURITY-MODEL.md`.

