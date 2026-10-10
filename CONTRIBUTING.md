# Contributing to NightOrder

NightOrder is an original project. Do not copy implementation code from Freqtrade or add funded-trading credentials, live trading endpoints, or production financial data.

## Branch and review policy

- Keep `main` releasable. Make changes on a short, focused feature or fix branch; do not commit directly to `main`.
- Open a pull request for every change and link the issue it addresses. Stack a dependent PR on its prerequisite PR only when the prerequisite is still open, and state the base branch in the PR description.
- Ask the owner of the affected package to review. Changes to `packages/domain`, shared database schema, safety boundaries, dependencies, or CI require review from both developers.
- Keep `pnpm-lock.yaml` in sync with package manifest changes. Do not mix unrelated work or overwrite another package owner's changes.
- Describe behavior, validation commands and results, evidence, and any known gaps in each PR. Do not claim live market access or fills without captured, verifiable evidence.

## Validation

For workspace changes, run the checks provided by the root `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The GitHub Actions `Validate workspace` check must pass before merge. A maintainer should configure the GitHub repository's `main` branch rules to require pull requests and this check; branch protection is a repository setting and is not established by this document alone.

## Safety review

- PAPER orders are simulated records, never live orders. An accepted order is not a fill.
- Never place model output directly on an execution path. Deterministic guards and independent readback remain mandatory.
- Keep credentials out of source, logs, traces, PRs, and screenshots. Use fixtures labeled as fixtures.
