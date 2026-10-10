# 04 · Parallel tasks without blocking

## Ownership
**Developer A (teammate)**: `apps/worker`, `packages/quotes`, `packages/execution`, `packages/agent`, recovery; initial Entire installation and checkpoints.
**Developer B (you)**: `apps/web`, `packages/telegram`, `packages/domain` (first contract PR), `packages/verifier`, `packages/tracing`; Neatlogs SDK and UI.
**Joint**: DB schema freeze, acceptance tests, cfo.ai, public build logs, demo and submission. Choose exactly one DB migration owner (A suggested); B reviews migrations before merge.

## GitHub issues and independent implementation
| Issue file | Owner | Depends on | Completion proof |
|---|---|---|---|
| 00-bootstrap | Joint (B pushes) | None | Repo, branch names, both collaborators, Entire active |
| 01-contracts | B + A review | 00 | Shared Zod schemas and contract tests |
| 02-runtime-quotes | A | 01 | Worker runs, fresh quote or labeled fixture, persists resume |
| 03-paper-execution | A | 01 | Guarded order and independent query, no duplicate order |
| 04-telegram | B | 01 | Instruction preview, exact approval, allowlisted owner |
| 05-agent-recovery | A | 02+03 | Actual model chooses diagnostic tools for ambiguous order |
| 06-verifier | B | 01; fixture adapter | Machine-readable invariants and refused/uncertain states |
| 07-neatlogs | B | 01; local stub | Real traces viewable and before/after comparison |
| 08-entire | A | 00 | Real Codex checkpoints with IDs/links |
| 09-cfo | Joint | None | Genuine business plan exported and reviewed |
| 10-dashboard | B | 01; fixture JSON | Working operator history and evidence UI |
| 11-three-runs | Joint | all core | Three E2E proofs, no inflated claims, demo capture |

**P0 critical path**: 00 → 01 → (02 + 03 + 04 + 06 + 07 + 08 + 09 in parallel) → 05 → 11. Dashboard (10) is nice-to-have until evidence works.

## Prevent integration conflicts
- A and B exchange only exported `packages/domain` contracts. Each other package is independently owned for first PRs.
- B can implement Telegram using `FakePlanRepository` and mocked command handler while A builds worker/execution. A can run price/agent tests with a `FixtureInstructionSource` before Telegram is ready.
- B writes verifier against `FakeExecutionPort` immediately; switch to A's adapter without API changes.
- A stubs `Neatlogs` with `TraceSink` port until B provides SDK integration. B can instrument fake tool spans before agent exists.
- Do not both edit `pnpm-lock.yaml` or root package files simultaneously. A handles dependency lockfile updates in one integration PR; B rebases.
- No direct commits to `main`. PRs target `main`; review contracts and financial safety. Short feature branches, e.g. `feat/quote-worker`, `feat/telegram-flow`, `feat/agent-recovery`.
- Each issue has a tiny passing test or evidence attachment. Open a PR at first passing slice; merge frequently. No huge end-of-day merge.
- Secrets are never in git or issue bodies. `git status` and secret scan before push.

## Daily coordination message (every 2–3h)
`Issue | branch/PR | tested behavior | evidence link | blocker (if any) | next action`

## High-risk handoffs
- `TradePlan` and quote precision: freeze early, no floats.
- DB migration owner and use of SQLite WAL under one always-on process. Do not access the SQLite file directly from separate cloud functions.
- Telegram authentication/approval boundary: B owns exact confirmation; A only consumes approved plans.
- Agent action requests cannot bypass A's guarded executor, or B's independent verifier.
