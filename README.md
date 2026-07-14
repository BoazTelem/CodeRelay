# CodeRelay

CodeRelay is a local desktop orchestration project for structured Worker/Auditor handoffs between the separately installed official Codex and Claude Code command-line tools. This repository is currently limited to the Windows technical proof phase: Milestones 0–2.

> CodeRelay is an independent open-source project and is not affiliated with, endorsed by, or sponsored by OpenAI or Anthropic.

> CodeRelay does not bundle Codex or Claude Code. Users install and authenticate the official command-line tools separately.

## Current boundary

Authorized now:

- Milestone 0 provider capability, authentication, isolation, and security proofs.
- Milestone 1 console orchestration utility with stub providers.
- Milestone 2 two real Windows handoffs and a redacted evidence bundle.

Not authorized before a recorded maintainer `GO`: polished Electron/React UI, macOS implementation, installers, signing, notarization, updates, or releases. Creating Milestone 2 evidence does not grant approval.

## Requirements

- Windows 10 or newer for real-provider Milestone 2 certification.
- Node.js 24.14.1, pinned for the Windows technical proof phase.
- Git.
- For real handoffs only: separately installed official `codex` and `claude` CLIs, each authenticated with a qualifying subscription. API-key or metered Console/API authentication is rejected.

## Development

```powershell
npm install
npm run check
npm run probe
npm run prototype
```

`npm run probe` records a redacted local capability report under `evidence/local/`. `npm run prototype` uses stub providers and does not contact OpenAI or Anthropic. `npm run milestone2` fails closed unless both providers are available, capability-proven, and normalized as `SUBSCRIPTION_VERIFIED`.

The authoritative product and security contracts live in [`docs/`](docs/). Contributor setup and safety rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).

## Privacy

CodeRelay has no telemetry, uploads no crash reports without consent, and stores no provider credentials. Real provider turns send prompts and relevant source code through the authenticated Codex and Claude services. The command environment is constructed from an allowlist and excludes API keys, cloud credentials, alternate endpoints, and unrelated environment variables.

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
