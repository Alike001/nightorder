# NightOrder | Team Bravo | neatHack 2026

**Set your trade. Rest. Verify the outcome.**

NightOrder is a Telegram-first autonomous **PAPER-only** trading agent for BTC/USDT. Traders describe exact entry conditions in everyday language, Gemini interprets their instruction, and the trader approves the resulting immutable plan. A background worker monitors live public prices and submits guarded simulated orders. Persistent evidence, bounded recovery, and Neatlogs traces help distinguish what happened from what was merely requested.

**No live-money orders, exchange credentials, custody, leverage, guaranteed returns, or public multi-user trading.**

## neatHack 2026 submission

Team Bravo's submission was received on October 12, 2026.

- [Final X post and 2:55 demo](https://x.com/IamAlikeX/status/2109768092385718293)
- [Public cfo.ai business model](https://cfo.ai/s/HW7EXJ-uQPEYOLdM), with hypothetical scenarios and no paying-customer actuals
- [Judge quickstart](#judge-quickstart) and [proof status](evidence/PROOF_STATUS.md), with the underlying [proof records](evidence/runs/)

The submitted live evidence covers Telegram instruction handling, Gemini interpretation, exact human approval, a live public quote, and an accepted PAPER order. The refusal and timeout-recovery scenarios are reproducible fixtures. NightOrder remains PAPER-only: `OPEN / ACKNOWLEDGED / NEW` is an accepted resting order, not a fill, and no real funds or profits are claimed.

## Watch the actual workflow

1. Send `/new` to the authorized Telegram bot with BTC/USDT, BUY or SELL, exact budget/size, trigger price, worst allowable execution price, and expiry.
2. Gemini proposes a structured plan; deterministic validation refuses invalid or incomplete terms. Review the displayed plan ID, revision, SHA-256 digest and UTC expiry.
3. Send the bot's **exact** `/confirm` command. Approval only **ARMS** monitoring, not a trade.
4. The PAPER worker reads live public BTC/USDT quotes, checks fresh data and approved bounds, and submits at most one simulated order per approved plan. Durable SQLite journal records the result.
5. Use `/plans` and `/status <planId>` to inspect state. `OPEN` or `ACKNOWLEDGED / NEW` means a paper order was accepted, **not filled**.

**In our October 12 live test:** a real Telegram instruction was parsed by Gemini; a human confirmed its exact digest; the worker reported `{"quoteKind":"LIVE_PUBLIC","outcomes":["ARMED","SUBMITTED"]}`; and Telegram `/status` showed `OPEN`, `ACKNOWLEDGED / NEW`, `ORIGINAL_PAPER`. This verifies the live Telegram-to-accepted-PAPER-order path, **not** a fill, profit, or real-money transaction. Application Neatlogs traces were ingested, including `paper.runtime.poll`; ingestion alone does not prove a trade outcome.

## Reproducible engineering evidence

| Scenario                                                       | Result                                                               | Important qualification                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| [A — authorized PAPER order](evidence/runs/run-a.json)         | `PASS`, one order, nine independent persisted-evidence checks passed | Deterministic price fixture                                     |
| [B — unsafe execution-limit refusal](evidence/runs/run-b.json) | `PASS`, zero orders submitted                                        | Deterministic price fixture                                     |
| [C — post-commit timeout recovery](evidence/runs/run-c.json)   | `PASS`, journal readback, no duplicate                               | **Scripted model fixture**, not a live Gemini recovery incident |

[Proof runner summary](evidence/runs/proof-runner.json) explicitly distinguishes fixture-based evidence from live application behavior. The PAPER adapter creates accepted/resting orders; it **does not simulate fills**.

## Architecture and trust boundaries

```text
Telegram message → Gemini structured interpretation → deterministic validation
              → exact digest/revision approval → shared SQLite plan repository
              → persistent watcher ← fresh Binance BTC/USDT public quote
              → guarded idempotent PAPER executor → order/attempt journal
              → independent verification + bounded recovery → truthful status
                           ↘ Neatlogs spans and trace evidence
```

The model interprets user intent and assists diagnostic tool selection, but **cannot override the authorization, time, quantity, price-limit, idempotency, or verification guards**. Freqtrade, OctoBot and FinRobot were research references only; this is not a Freqtrade fork.

- `packages/domain`: canonical instruction types, approval hashes and state transitions.
- `packages/telegram`: natural-language plan workflow and digest-bound confirmation.
- `packages/quotes`: public BTC/USDT market data.
- `packages/execution`: SQLite virtual-balance PAPER order journal and uniqueness guards.
- `packages/agent` and `packages/verifier`: bounded recovery and evidence checks.
- `packages/tracing`: Neatlogs SDK observability.
- `apps/worker`: Telegram and PAPER worker entry points.
- `apps/web`: **scaffold**, not a published trader dashboard.

## Install, test and reproduce

Requires Node.js >=22.14 and pnpm >=10.18.

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm proof:runs
```

### Judge quickstart

From a clean checkout, judges can independently run the repository's deterministic verification without Telegram, Gemini, Binance credentials, Neatlogs access, or a cfo.ai account:

```bash
git clone https://github.com/Alike001/nightorder.git
cd nightorder
pnpm install --frozen-lockfile
pnpm test
pnpm proof:runs
```

`pnpm test` runs the workspace tests. `pnpm proof:runs` creates three reproducible SQLite PAPER fixture proofs: authorized submission, refusal outside the approved execution limit, and recovery after a scripted post-commit timeout. These do **not** exercise Telegram transport, live Gemini inference, or an actual ambiguous live incident. The October 12 capture described above is separate live application evidence: real Telegram and Gemini instruction handling, a live public quote, and a guarded PAPER order accepted as `OPEN / ACKNOWLEDGED / NEW`. That order was **not filled**. The proof runner refreshes timestamps and generated IDs in `evidence/runs/`; inspect its output as a run record and do not treat those generated IDs as stable references.

The timed recording plan is in [demo/final-demo-script.md](demo/final-demo-script.md). It uses the October 12 evidence captures, clearly marks fixture scenes, and includes the public cfo.ai model.

The proof runner uses fixtures and does not call Telegram or Gemini. For the **private live PAPER application**, provision your own Telegram token, Gemini key and Neatlogs project key, and set the following in a private file outside the Git repository:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS          # exactly one numeric Telegram ID
NIGHTORDER_AI_PROVIDER=GEMINI
GEMINI_API_KEY
GEMINI_MODEL
NEATLOGS_API_KEY
NIGHTORDER_DATABASE_PATH           # same absolute path for both workers
NIGHTORDER_WATCHER_DATABASE_PATH   # separate absolute SQLite path
NIGHTORDER_PAPER_DATABASE_PATH     # separate absolute SQLite path
NIGHTORDER_ENABLE_PAPER_EXECUTION=true
NIGHTORDER_PAPER_POLL_MS=5000
NIGHTORDER_PAPER_INITIAL_USDT=1000
NIGHTORDER_PAPER_INITIAL_BTC=0.25
```

After loading the environment into **each** terminal, start one instance of each process:

```bash
pnpm --filter @nightorder/worker start:telegram
# In another shell with the same configuration:
pnpm --filter @nightorder/worker start:paper
```

Never commit `.env`, SQLite database files, auth tokens, AWS keys or private Entire session contents. The CLI processes must keep running locally; **always-on cloud deployment is not claimed**.

### Judge access

The current Telegram interface uses a **single-server-side-user allowlist**. Judges cannot access the private bot using their own Telegram accounts; the owner must not share their token, user ID, or private database. Judges can verify the public code and fixture proofs using the quickstart above. The live Telegram screenshots and Neatlogs screenshots are submission attachments, not public dashboard URLs in this repository. An isolated judge sandbox is future work.

## neatHack partner integrations

| Partner      | Genuine role                                                                                                                                       | Evidence                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neatlogs** | Semantic WORKFLOW/AGENT/TOOL/GUARDRAIL tracing in Telegram and PAPER runtime, sensitive inputs masked; fixture-based numerical evaluation harness. | [Integration code and setup](packages/tracing). The team supplied genuine screenshots of `paper.runtime.poll` and ingestion for the submission; there is no public trace URL in this repository.                                                                                                          |
| **Entire**   | Real Codex-assisted development checkpoints, session context and code provenance.                                                                  | [Public checkpoint notes on `main`](https://github.com/Alike001/nightorder/blob/main/evidence/ENTIRE.md). The underlying Entire checkpoint repository is private unless access is granted.                                                                                                                |
| **cfo.ai**   | A public NightOrder business model with scenario analysis and runway, based on explicitly hypothetical assumptions.                                | [Public cfo.ai model](https://cfo.ai/s/HW7EXJ-uQPEYOLdM) · [Documented assumptions and limitations](business/cfo-ai-model-draft.md). The project includes Assumptions, Operating Model, Financial Model, and Decision Dashboard exports. These projections are not actual revenue or validated forecasts. |

Entire is **not** a Telegram notification provider. cfo.ai is **not** a real-time trading risk oracle.

## Product scope and honest limitations

- Supports **BTC/USDT only**. ETH/SOL and unrestricted multi-asset trading are not implemented.
- PAPER trading only. An `OPEN` order is not a fill. Real-money trading and exchange order placement are out of scope.
- Single authorized Telegram account; no multi-tenant isolation, public judge sandbox, browser trader UI, or continuously hosted deployment yet.
- Fixture tests prove guard refusal and scripted timeout recovery. They **do not** establish that live Gemini-driven incident recovery has succeeded in production.
- Approval preview must be checked carefully, including UTC expiry. An earlier timezone conversion mistake was found during testing; the successful live run used an explicit UTC expiry.
- Never trust AI output over deterministic authorization, price, expiry or evidence checks. No investment advice or profitability claims.

## Team and source

Team Bravo: two independent blockchain-development trainees at Web3Bridge, one Physics graduate and one final-year Physics student at Lagos State University. Built for neatHack 2026.

- The integrated release is on [`main`](https://github.com/Alike001/nightorder/tree/main) (release and evidence PRs [#31](https://github.com/Alike001/nightorder/pull/31), [#32](https://github.com/Alike001/nightorder/pull/32), and [#33](https://github.com/Alike001/nightorder/pull/33) are merged).
- [Product and scope](docs/01_PRODUCT_AND_SCOPE.md) · [Architecture and safety](docs/03_ARCHITECTURE_AND_SAFETY.md) · [Proof plan](docs/05_TEST_AND_PROOF.md) · [Submission and sponsor guide](docs/06_SPONSORS_AND_SUBMISSION.md)
- [neatHack 2026](https://neatlogs.com/hackathon)
