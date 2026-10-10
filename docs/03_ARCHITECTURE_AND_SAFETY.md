# 03 · Architecture, agent logic and safety

## Architecture

```text
Telegram Bot API <-> apps/worker Telegram adapter <-> PlanRepository(SQLite)
                                               |             ^
                         deterministic price watcher <-> MarketDataPort(public bid/ask)
                                               |
                         policy guard + atomic execution claim
                                               |
                     ExecutionPort (ORIGINAL PAPER / optional TESTNET)
                                               |
                          readback verifier and execution journal
                                               |
                    Telegram report + Next.js read-only evidence UI
                                               |
                      Neatlogs workflow/agent/tool/guard traces

           bounded LLM agent <-> read-only diagnostics + guarded requests
```

Only the agent chooses *diagnostic* tools when the runtime observes unexpected conditions. Price polling and hard bounds require no LLM; keep token spend bounded.

## State machine
`DRAFT → AWAITING_CONFIRMATION → ARMED → TRIGGERED → SUBMITTING → OPEN / FILLED / PARTIALLY_FILLED / REJECTED / UNCERTAIN`

`ARMED → EXPIRED` if no order. `UNCERTAIN → (verified venue status or NEEDS_HUMAN)` after checking journal and remote ID; no automatic resubmission. `OPEN → CANCEL_REQUESTED → CANCELLED` only on readback. Order may be PARTIALLY_FILLED or remain open after expiry until cancellation confirmed.

## Non-negotiable constraints
1. PAPER or TESTNET only, spot BTCUSDT only. Testnet credentials must NEVER be live credentials. No live-trading toggle in P0.
2. All commands restricted to allowlisted Telegram account; confirm exact plan summary and approval digest.
3. BUY: freshest executable ask <= user trigger and worst limit price <= approved max; total virtual USDT including modeled fees <= budget. SELL: executable bid >= trigger and quantity within approved BTC.
4. Reject stale or absent prices, invalid tick/lot/min notional, insufficient balance, malformed instruction, expired or cancelled plans. Never widen a limit to make a trade work.
5. Validate signed/atomic plan approval before any write. One active submission per plan; durable operation ID and client order ID; no concurrent double claims.
6. HTTP/network timeout after possible commit => persist `UNCERTAIN`, query by client ID and inspect journal. Do not resubmit automatically even if not immediately found. Escalate if cannot establish truth.
7. Persist state before side-effect, not afterward. Restart must reconcile pending operations before processing new ones.
8. Track accepted/open/partial/filled/expired/cancelled separately. `CANCEL_REQUESTED` is not `CANCELLED`. Accepted is not filled. PAPER fill is explicitly simulated.
9. Model-generated text is untrusted, parsed with Zod, never executed as shell or raw SQL. Model has no direct credentials; tool use audited and bounded by step and spend caps.
10. Secrets stored only in local env/secret store, never source, screenshot, Telegram replies, Neatlogs span attributes or demo.
11. Offline means user's phone/laptop can be off; backend worker must remain running. AWS account $25 and resource rules apply; use us-east-1 only.
12. No promises of guaranteed fill, guaranteed profit, or zero-loss; outages can result in missed triggers. Report this accurately.

## Exactly-once caveat
Database atomic claims provide **at-most-once local submission initiation**, not universal exactly-once remote order execution. Reusable client IDs, remote timeouts, venue behavior and failover can invalidate naive guarantees. If remote status remains ambiguous, `NEEDS_HUMAN` and **no second order**.

## Minimal model-agent loop
1. Receive an `INCIDENT` (e.g., stale data, rejected order, timeout, status mismatch).
2. Load plan and compact redacted context (past observed tool calls + action journal).
3. Request one allowed diagnostic tool (e.g., read quote, read attempt, query remote order).
4. Update durable observation; ask model to select a next diagnostic step from evidence.
5. Allow only `requestGuardedExecution`, `requestGuardedCancellation`, or `escalate`, each checked by deterministic controller.
6. Run independent verifier. If failure remains, bounded retry of **read-only** diagnostics, else escalate.
7. Record actual final state, refusal or uncertainty. Never invent trace events or LLM chain-of-thought.

## Minimal failure injection
The original paper adapter can commit an order record to SQLite, then purposely throw a `TIMEOUT` **after writing**. Keep the injection toggle test-only. Verifier queries persisted orders and requires exactly one clientOrderId and zero duplicate attempts.
