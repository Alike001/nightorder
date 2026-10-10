# NightOrder · Team Bravo · neatHack 2026

**Set your trade. Rest. Verify the outcome.**

This is the single-source-of-truth **planning and team-coordination starter**, not a finished agent. Competition application code must be written during neatHack. Use the README and issue bodies to coordinate work, then implement and test each gate.

## What we locked
- **Product**: a Telegram-first, autonomous **paper-trading** instruction supervisor. An authorized trader chooses asset, BUY/SELL, exact size, trigger, worst allowed price, and expiry. The app confirms their exact plan, monitors fresh market quotes, submits only guarded test/paper orders, handles ambiguous outcomes, verifies and reports truthfully.
- **Name**: NightOrder is the hackathon working name (not trademark/domain-cleared).
- **NO live money, leverage, futures, unsolicited trades, profitability promises, or unlimited AI permissions.**
- **Original code**: Freqtrade, OctoBot and FinRobot are research references ONLY. No fork, Freqtrade runtime dependency, or copied implementation. Existing public market-data, Telegram and testnet APIs remain legitimate infrastructure choices subject to organizers' rules.
- **Agent**: one bounded AI diagnostic agent. Monitoring, price comparisons, authorization and order constraints are deterministic. The model can investigate inconsistent results and request guarded actions but cannot hold unrestricted exchange credentials.
- **Required sponsors**: Neatlogs (real runtime traces and before/after comparison), Entire (actual Codex development checkpoints), cfo.ai (genuine business plan with pricing, costs, revenue, runway).

## Start here
1. Read `docs/01_PRODUCT_AND_SCOPE.md` and `docs/02_SHARED_CONTRACTS.md` together for 15–30 minutes.
2. Set the owner names in `docs/04_TASKS_AND_GIT_WORKFLOW.md`. Developer A = teammate (runtime/execution/agent/Entire); Developer B = user (Telegram/domain/verifier/Neatlogs/UI).
3. Initialize git, push to GitHub, invite your teammate as collaborator, and create issues from `issues/` using `scripts/create-issues.sh` (instructions in `docs/07_START_HERE_LINUX.md`).
4. **Parallel work is allowed after contract freeze**: A works in `apps/worker`, `packages/quotes`, `packages/execution`, `packages/agent`; B works in `apps/web`, `packages/telegram`, `packages/domain`, `packages/verifier`, `packages/tracing`. DB schema merged by one designated owner; coordinate one contract PR early.
5. Do not block the worker on Telegram or the UI on the execution service. Use fixtures and typed interface adapters with exact shared contracts.
6. Gate 1 = approved plan → persisted order in explicitly labeled PAPER mode → independent readback. Only then expand.

## Documents
- `docs/01_PRODUCT_AND_SCOPE.md`: problem, novelty test, scope.
- `docs/02_SHARED_CONTRACTS.md`: domain types, ports, states, error definitions.
- `docs/03_ARCHITECTURE_AND_SAFETY.md`: security and no-duplicate rules.
- `docs/04_TASKS_AND_GIT_WORKFLOW.md`: tasks, dependencies, branches, PRs.
- `docs/05_TEST_AND_PROOF.md`: three acceptance scenarios and evidence.
- `docs/06_SPONSORS_AND_SUBMISSION.md`: exact partner roles and submission checklist.
- `docs/07_START_HERE_LINUX.md`: terminal, GitHub, Entire and Codex kickoff.
- `docs/08_TEAMMATE_HANDOFF.md`: brief message to share.
- `issues/`: copy-ready GitHub issue bodies, with unique titles and ownership.

## Authoritative references
- https://neatlogs.com/hackathon
- https://neatlogs.com/hackathon/neatlogs-setup-guide.html
- https://docs.neatlogs.com/sdk/typescript
- https://hack.entire.io/neathacks-2026/
- https://github.com/freqtrade/freqtrade (study reference)
- https://github.com/Drakkar-Software/OctoBot (study reference)
- https://github.com/binance/binance-spot-api-docs (optional testnet/exchange API spec)
