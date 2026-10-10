# `@nightorder/domain`

Shared, runtime-validated contracts for NightOrder's original paper-trading system.

## Safety boundary

- Only `BTCUSDT`, spot-style BUY/SELL instructions, and `PAPER` mode are accepted.
- Monetary values are positive base-10 strings. Signs, exponent notation, leading zeroes, and JavaScript numbers are rejected.
- BUY plans carry `quoteBudgetUsdt` and use `ASK_LTE`; SELL plans carry `baseQuantityBtc` and use `BID_GTE`.
- Timestamps must be UTC ISO-8601 values ending in `Z`; the display timezone is a valid IANA name.
- State changes require an allowed transition, an explicit UTC transition time, exactly one revision increment, unchanged instructions, and an intact approval digest.
- Submit responses accept only `NEW`, `PARTIALLY_FILLED`, or `FILLED`; rejection and expiry use the typed error branch.
- Cancellation commands return `CANCEL_REQUESTED`. Only a separate durable readback can establish `CANCELED`.
- A `VERIFIED` result requires every named safety check and at least one unique evidence reference. `UNCERTAIN` may have no references when all evidence reads fail; it must not invent one.

## Approval digest

`hashTradeInstruction` computes lowercase SHA-256 over UTF-8 JSON with this fixed field order:

```text
id, ownerId, symbol, side, quoteBudgetUsdt, baseQuantityBtc,
triggerPrice, triggerOperator, limitPrice, expiresAtUtc, timezone, mode
```

Undefined side-inapplicable quantity fields are omitted. Values are hashed exactly as approved; decimal strings are not converted to binary floating point or normalized after approval.

The plan schema validates this digest itself. Changing an immutable field without recomputing the digest fails schema validation, and changing either the instruction or digest during approval or afterward fails transition validation.

## Verification checks

The verifier must report every required check:

```text
PLAN_HASH_MATCHES, PLAN_APPROVED, OWNER_AUTHORIZATION_MATCHES,
PLAN_NOT_EXPIRED_AT_SUBMISSION, ORDER_ATTEMPT_UNIQUE,
ORDER_REQUEST_MATCHES_PLAN, EXECUTION_STATUS_MATCHES,
CANCELLATION_STATE_MATCHES, PAPER_EVIDENCE_ONLY
```

`VERIFIED` is valid only when all checks pass. `BLOCKED` and `UNCERTAIN` require at least one failed or unresolved check. Evidence references must be unique; only `VERIFIED` requires a non-empty list.

`PersistentRecordsVerifierAdapter` computes these names itself from strict,
read-only records. It never accepts model-provided check names. Its reader must
return independently identifiable records for the plan, owner authorization,
attempt query, and paper order. Missing or malformed evidence produces
`UNCERTAIN`; unavailable checks are `false`, never padded with `true`. A complete
but contradictory record set produces `BLOCKED`.

## Recovery escalation

`PlanRepository.markNeedsHuman(planId, reasonCode)` returns a typed
`ToolResult<NeedsHumanEscalation>`. The escalation is an orthogonal durable row,
not a substitute for order state. In particular, `SUBMITTING`, `OPEN`,
`PARTIALLY_FILLED`, `UNCERTAIN`, and `CANCEL_REQUESTED` must remain visible while
an escalation is open. The state machine therefore forbids changing
`UNCERTAIN` or `CANCEL_REQUESTED` to `NEEDS_HUMAN`.

Repository adapters must implement the following transaction contract:

1. Read the current plan state and revision in the write transaction.
2. Compare that revision before inserting. Return `STALE_REVISION` on a race.
3. Insert one row keyed uniquely by `(plan_id, reason_code)`, recording the
   matching SHA-256 `idempotencyKey`, plan state, plan revision, reason, creation
   time, and a stable evidence ID.
4. On an idempotent retry, return the original row and evidence ID.
5. Return `PERSISTENCE_FAILED` unless the row durably committed. Never report
   escalation success based only on an in-memory label or trace event.

The record ID plus the `ToolResult.evidenceId` provide the audit reference. The
recovery agent must inspect `result.ok`; calling the method without a thrown
exception is not proof that persistence succeeded.

## SQLite paper compatibility

`mapSqlitePaperOrderAttempt` is the validated boundary for the teammate paper
adapter. The mapping is exact:

| SQLite `PaperOrderAttempt` | Canonical `OrderAttempt` |
| -------------------------- | ------------------------ |
| `id`                       | `id`                     |
| `planId`                   | `planId`                 |
| `operationId`              | `operationId`            |
| `clientOrderId`            | `clientOrderId`          |
| `requestDigest`            | `requestDigest`          |
| `createdAtUtc`             | `createdAtUtc`           |
| `orderId`                  | `remoteOrderId`          |
| `venueStatus`              | `venueStatus`            |
| `evidenceSource`           | `evidenceSource`         |
| `reconciledAtUtc`          | `reconciledAtUtc`        |

Optional evidence stays absent. The mapper does not synthesize an order ID,
venue status, creation time, or reconciliation time. Canonical validation then
requires acknowledged/reconciled attempts to have order evidence and requires
only reconciled attempts to have `reconciledAtUtc`.

The SQLite executor currently returns `{ status: "CANCELED" }` from the cancel
write itself. `mapPaperCancelAcknowledgement` deliberately converts that command
response to `{ status: "CANCEL_REQUESTED" }`. Call
`findOrderByClientId` separately and validate it with `mapPaperOrderReadback`;
only that read can drive the plan to `CANCELLED`.

## Teammate-side adapter changes

No teammate-owned runtime code is changed by this package. Integration requires:

- Recovery: replace its local arbitrary `VerificationResult` with the domain
  type/adapter, import the domain reason-code type, await `markNeedsHuman`, and
  set `escalationPersisted` only when the returned `ToolResult` is `ok: true`.
- Plan repository: add the transactional escalation table/write described
  above. Do not implement escalation as `UPDATE plans SET state =
'NEEDS_HUMAN'` for a potentially active order.
- Paper executor: pass `getAttemptForPlan` through
  `mapSqlitePaperOrderAttempt`; preserve the row's real values instead of
  hard-coding `ACKNOWLEDGED`/`NEW`. On confirmed cancellation readback, persist
  the attempt as `RECONCILED`, set `venue_status = 'CANCELED'`, and set the real
  `reconciled_at_utc` in the same transaction as the order update.
- Execution port adapter: map the immediate cancel result with
  `mapPaperCancelAcknowledgement`, then use a separate order readback before a
  `CANCELLED` plan transition.
- Verifier reader: expose the actual plan row, approval/owner record, full
  attempt-query result, and paper-order row with stable evidence IDs. Do not use
  the recovery model's check map as verifier input.

## Commands

```sh
npm install --no-package-lock
npm run typecheck
npm test
npm run build
```
