# Open-Source and Release Governance

The repository uses Apache-2.0, a notice and trademark disclaimer, contribution/security/conduct/support policies, issue forms, a pull-request checklist, weekly dependency updates, stub-only cross-platform CI, dependency review/audit, CodeQL, secret scanning, and CycloneDX generation.

Enable GitHub secret scanning and push protection in repository settings when available. Replace placeholder owner links and the placeholder `@maintainers` CODEOWNERS team when the repository is published. Protect `main` with required reviews and passing checks.

The `release` GitHub Environment must be maintainer-only and protected by required reviewers. Its current workflow is only an authorization guard: no artifacts are packaged, signed, attested, or published before a recorded Milestone 2 `GO`.

After `GO`, a separately reviewed release workflow must produce installers, CycloneDX JSON, SHA-256 checksums, Sigstore/cosign signatures, GitHub artifact attestations/provenance, and the redacted signed human certification report. It must use least-privilege permissions, pinned actions, protected signing identities, and GitHub Releases. Public CI must never contain personal provider subscription credentials.

