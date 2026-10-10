# 08 · Brief handoff to teammate

Team Bravo: **NightOrder** is locked as our hackathon working name and scope. This ZIP is the updated **from-scratch** plan; **Freqtrade is research ONLY**, not an installed dependency or existing app we are submitting.

Goal: a trader approves a precise paper-trading instruction over Telegram, sleeps, and wakes to truthful, independently verified order state. AI handles understanding and diagnostic recovery; deterministic code controls authorization, amounts, price, expiry, precision, and no-duplicate execution.

Please inspect `docs/02_SHARED_CONTRACTS.md` and confirm within 30 minutes: BTCUSDT-only, decimal strings, stable clientOrderId and OperationId, state machine, and `MarketDataPort`/`ExecutionPort`/`PlanRepository` interfaces. Then we work in parallel. You own runtime/quotes/agent/execution/recovery/Entire. I'll own Telegram/contracts/verifier/Neatlogs/dashboard. cfo.ai and tests are joint.

Priorities: G1 original worker + persistent quote, G2 approved plan → PAPER order → independent readback, G3 model-selected diagnostics + timeout recovery, G4 three actual proof runs, G5 sponsor evidence + 3-minute demo.

Use `issues/` GitHub issue bodies and feature branches. Please don't wait for my Telegram UI: use a fixture-approved plan. I won't wait for your execution engine: my verifier and Telegram UI will use contract stubs. No large merged feature branches at the end.

No real money. No fabricated traces. No copying an existing application. Update progress with issue, branch, test result, blocker and next action.
