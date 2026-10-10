# `@nightorder/domain`

Shared, runtime-validated contracts for NightOrder's original paper-trading system.

## Safety boundary

- Only `BTCUSDT`, spot-style BUY/SELL instructions, and `PAPER` mode are accepted.
- Monetary values are positive base-10 strings. Signs, exponent notation, leading zeroes, and JavaScript numbers are rejected.
- BUY plans carry `quoteBudgetUsdt` and use `ASK_LTE`; SELL plans carry `baseQuantityBtc` and use `BID_GTE`.
- Timestamps must be UTC ISO-8601 values ending in `Z`; the display timezone is a valid IANA name.
- State changes require an allowed transition, an explicit UTC transition time, exactly one revision increment, unchanged instructions, and an intact approval digest.
- Submit responses accept only `NEW`, `PARTIALLY_FILLED`, or `FILLED`; rejection and expiry use the typed error branch.
- Cancellation requests return `CANCEL_REQUESTED`. Only independent readback can establish `CANCELED`.
- A `VERIFIED` result requires every named safety check and at least one unique evidence reference.

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

`VERIFIED` is valid only when all checks pass. `BLOCKED` and `UNCERTAIN` require at least one failed or unresolved check. Every result requires unique, non-empty evidence references.

## Commands

```sh
npm install --no-package-lock
npm run typecheck
npm test
npm run build
```
