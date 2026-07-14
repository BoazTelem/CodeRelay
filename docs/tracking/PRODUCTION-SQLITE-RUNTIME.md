# Decide and pin the production SQLite runtime before packaging

Status: POST-GO REQUIREMENT  
Owner: Maintainer  
Gate: Must be resolved before production packaging begins

## Context

Milestones 0–2 are tested with Node.js 24.14.1 and Node's built-in `node:sqlite` API. That runtime emits an experimental-feature warning. The warning is not a Milestone 0–2 blocker and does not invalidate the technical proof results.

## Required decision

After a recorded Milestone 2 `GO`, evaluate and record whether production CodeRelay will:

1. Retain Node's built-in SQLite API with an explicitly pinned Electron/Node runtime and acceptance evidence; or
2. Package a maintained SQLite dependency and accept its native-module, cross-architecture, signing, and updater implications.

The decision must cover Windows x64, macOS Intel, and macOS Apple Silicon; migration and corruption recovery; native-module ABI compatibility; packaging/rebuild behavior; security maintenance; and release reproducibility.

## Acceptance criteria

- An architecture decision record identifies the selected runtime and rejected alternative.
- The exact Electron, Node, and SQLite versions are pinned.
- Migration, backup, integrity-check, corruption-recovery, and crash-reconciliation tests pass on every production architecture.
- Installer and update tests prove that the database runtime is present and loadable after a clean install and an N-1 to N update.
- The SBOM and third-party notices describe the final dependency choice.

This item authorizes no implementation before the Milestone 2 maintainer gate records `GO`.
