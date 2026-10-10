# `@nightorder/domain`

Shared, runtime-validated contracts for NightOrder's original paper-trading system.

## Safety boundary

- Only `BTCUSDT`, spot-style BUY/SELL instructions, and `PAPER` mode are accepted.
- Monetary values are positive base-10 strings. Signs, exponent notation, leading zeroes, and JavaScript numbers are rejected.
- BUY plans carry `quoteBudgetUsdt` and use `ASK_LTE`; SELL plans carry `baseQuantityBtc` and use `BID_GTE`.
- Timestamps must be UTC ISO-8601 values ending in `Z`; the display timezone is a valid IANA name.
- State changes require an allowed transition, exactly one revision increment, unchanged instructions, and an intact approval digest.

## Approval digest

`hashTradeInstruction` computes lowercase SHA-256 over UTF-8 JSON with this fixed field order:

```text
id, ownerId, symbol, side, quoteBudgetUsdt, baseQuantityBtc,
triggerPrice, triggerOperator, limitPrice, expiresAtUtc, timezone, mode
```

Undefined side-inapplicable quantity fields are omitted. Values are hashed exactly as approved; decimal strings are not converted to binary floating point or normalized after approval.

## Commands

```sh
npm install --no-package-lock
npm run typecheck
npm test
npm run build
```
