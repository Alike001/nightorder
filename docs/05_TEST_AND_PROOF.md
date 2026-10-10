# 05 · Acceptance suite, evidence and truth-in-demo

## Run A · Authorized plan lifecycle
- Given new allowlisted Telegram user, `BUY BTCUSDT / 50 USDT / ask <= 60000 / limit <= 60000 / expire 07:00 Africa/Lagos`.
- Parse, preview, confirm exact digest; store immutable plan; watcher checks quote timestamp and asks deterministic guard to act only after condition.
- Send precisely one original PAPER order; independently query persisted paper order by stable clientOrderId; Telegram reports the **actual** status.
- For deterministic reproduction, test fixture quote triggers the threshold and is labeled `TEST_FIXTURE`; public market feed must be demonstrably available separately. No invented real market price movement.
- **PASS**: one approved plan, one attempt, no budget overrun, evidence readback, correct status.

## Run B · Block an unauthorized or unsafe action
- Confirm plan then provide stale quote, invalid lot/min-notional or insufficient virtual balance; agent must select relevant diagnostics and recognize the constraint.
- Deterministic guard refuses to submit. Agent cannot silently increase quantity, loosen price or use different pair.
- **PASS**: zero order rows for the case; `BLOCKED` verdict with machine-readable reason; user informed truthfully.

## Run C · Commit then timeout
- Paper executor inserts durable order and records `clientOrderId`, then test transport throws `TIMEOUT` before caller receives success.
- Agent reviews journal, queries remote/paper order by ID, reconciles state without submitting another order. If true status remains uncertain, escalate.
- **PASS**: one actual order record, zero duplicate order submissions, tracer shows failure → diagnostic read → reconcile → independent check.

## P1 stress test (only if time)
- Restart worker while plan is armed or submitting. Rehydrate plan and pending attempts; reconcile before any new mutation.

## Independent verifier reads
1. Approved plan hash, confirmation timestamp, owner and UTC expiry.
2. Fresh source quote and approved trigger/limit bounds.
3. Actual order record/status from adapter, not agent narrative.
4. Max amount and balance math in decimal arithmetic.
5. Count of attempts and accepted orders per plan.
6. Distinguish `ORDER_ACCEPTED` from `FILLED`, `CANCEL_REQUESTED` from `CANCELLED`, and `PAPER` from `TESTNET`.
7. Recorded final user report corresponds exactly to verified state.

## Neatlogs evaluation design
- Early baseline: run incident fixture on initial agent and record `runId`, traces and failure modes.
- Later fix: run same fixture/versioned spec; compare `resolution_correct`, `unsafe_write_count`, `duplicate_order_count`, `tool_calls`, `time_to_safe_state`.
- Never claim improvement if tests differ materially or only traces were cosmetically changed.

## Artifacts to put under `evidence/`
- `runs/run-a.json`, `runs/run-b.json`, `runs/run-c.json` (sanitized, produced by actual application).
- `EVALUATION.md`: before/after trace IDs and metrics.
- `ENTIRE.md`: checkpoint URL/IDs.
- `CFO.md`: actual cfo.ai plan source and export/link.
- `SECURITY_ASSERTIONS.md`: list of tested invariants.
- `DEMO.md`: link to <3-minute demo.
- `BUILD_LOG.md`: dated public development evidence.

The above are **expected artifact names**, not claims that tests have passed. Keep evidence honest.
