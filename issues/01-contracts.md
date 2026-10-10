# [P0] Freeze shared TypeScript trade and execution contracts

**Owner:** B implements / A reviews  
**Depends on:** 00-bootstrap  
**Priority:** P0

## Objective
Implement the minimum behavior described by this issue while following `docs/02_SHARED_CONTRACTS.md` and `docs/03_ARCHITECTURE_AND_SAFETY.md`.

## Acceptance criteria
Zod TradePlan/MarketQuote/OrderAttempt, decimal-safe price guards and interfaces; test confirms exact plan digest and rejects disallowed symbols/amounts; initial contract PR reviewed by both.

## PR requirements
- Link to this issue and provide actual test commands/results.
- Preserve agreed types; discuss shared schema or lockfile edits with other developer first.
- No production financial credentials, no live-money trading, no private sponsor access links.
- Attach truthful evidence of failure/success where applicable.
