# Completion and Blocking Rules

**Rule-set version:** 1.0.0-proof  
**Status:** normative

## 1. Completion is an orchestrator decision

Provider phrases such as “done,” “approved,” or “tests pass” never complete a Work Item. The orchestrator marks `COMPLETED` only when all categories below have machine-verifiable evidence.

### Acceptance

- Every current TaskContract acceptance criterion has a recorded evidence reference and passing status.
- No requirement is satisfied solely by an unverified provider claim.
- The final verifier reviewed the same contract revision and final diff.

### Validation

- Every required project-profile command ran through the trusted orchestrator after the final change.
- Required tests, formatting checks, lint, type checks, builds, and project-specific validations passed or are explicitly inapplicable in the contract.
- Results record executable identity, arguments, working directory, sanitized environment digest, start/end time, exit status, bounded output hash, and log reference.

### Review

- A fresh, read-only, independent Auditor reviewed the full current implementation.
- A fresh, read-only Final Verifier approved final evidence.
- No P0, P1, blocking P2, policy violation, or unresolved previously-undetectable safety issue remains.
- P3 and preexisting out-of-scope items appear separately and never block.

### Scope and Git

- Every changed/untracked path is approved and no prohibited path or `.git` entry was mutated by a provider.
- Final branch, commit, index, diff, and file hashes match the recorded checkpoint.
- The isolated branch descends from the recorded base and contains only intended checkpoint commits.
- The primary checkout matches its preflight branch, HEAD, index, diff, and untracked manifest.

### External effects and human authority

- Evidence confirms no push, merge, rebase, reset, clean, deploy, migration, publish, automatic PR creation, or other prohibited side effect occurred.
- No required user decision, credential action, production operation, database migration authorization, merge, deployment, or release remains pending for the requested local task.
- The final report clearly lists any later manual actions without performing them.

## 2. Mandatory blocking conditions

Block and preserve evidence when any of these occurs:

- A requested or observed production mutation, migration, publishing, merge, push, or other hard-denied action.
- Authentication other than verified subscription, or authentication mode cannot be proven.
- Customization isolation, command brokering, filesystem confinement, session independence, or validation authority cannot be proven.
- Material product/business ambiguity or requested scope expansion needing user authority.
- Role/session conflict, including Worker self-review.
- Repeated path/Git policy violation after one focused correction.
- The same blocking finding remains after two focused repairs.
- Two consecutive no-progress fingerprints.
- An iteration/replan/schema-correction limit is exhausted.
- Provider disagreement cannot be resolved by deterministic evidence.
- Required infrastructure, executable, subscription capacity, or validation tool is unavailable.
- Crash reconciliation cannot match database, process, Git, and artifact state.
- Database integrity fails.

A block report includes stage/status, plain-language reason, evidence references, last safe checkpoint, actions already attempted, exact human/external condition required to resume, and whether a new TaskContract revision is required.

## 3. Pause versus block versus failure

- `PAUSED` is resumable without architecture or contract change: user pause, subscription exhaustion, temporary provider outage, or safe intervention boundary.
- `BLOCKED` needs explicit human decision, remediation, compatibility proof, or contract revision.
- `FAILED` is reserved for an internal error after safe state is persisted and recovery cannot continue automatically; it still includes a reconciliation report.
- `ABORTED` is an explicit user stop.

No state deletes the isolated branch, worktree, provider session, or evidence automatically.

## 4. Progress algorithm

Hash the canonical final diff, changed-file list, normalized validation failures, normalized blocking findings, criterion status, stage, and provider decision. Identical material state after a repair is one no-progress occurrence. Scope oscillation or unchanged disagreement also counts. The first occurrence generates one focused repair with exact evidence; the second consecutive occurrence blocks. Any substantive diff/evidence improvement resets the consecutive counter but not finding-specific repair limits.

## 5. Final report schema content

The report contains schema version, Work Item/status, contract and plan versions, repository/base/isolated branch/final commit, starting context, assignments and hashed session identities, per-stage trace, iterations, changed files and hashes, validation results, review/final-verifier decisions, acceptance evidence, resolved/open/P3 findings, policy decisions and violations, primary-checkout comparison, confirmation of prohibited actions not occurring, privacy/redaction statement, and remaining human actions.

For Milestone 2 the report ends at `AWAITING_MAINTAINER_DECISION`; it cannot authorize post-GO work.

