# Contributing

CodeRelay is in the Milestones 0–2 proof phase. Contributions must preserve the execution boundary in `docs/PRODUCT-SPEC.md`: do not add the polished desktop UI, macOS runtime support, packaging, signing, updates, or release implementation without a recorded Milestone 2 `GO` decision.

## Setup

1. Install Node.js 22.13 or newer and Git.
2. Run `npm install`.
3. Run `npm run check` before submitting a change.
4. Use stub providers in public CI. Never add provider credentials, subscription sessions, raw provider logs, or personal configuration.

Changes to workflow schemas or prompts must update the authoritative documentation, schema examples, prompt snapshots, and tests together. Security-policy restrictions may be added but never weakened by a project profile.

By contributing, you agree that your contribution is licensed under Apache-2.0 and that you will follow `CODE_OF_CONDUCT.md`.

