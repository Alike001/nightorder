# [P0] Original guarded PAPER executor with durable order journal

**Owner:** A  
**Depends on:** 01-contracts  
**Priority:** P0

## Objective
Implement the minimum behavior described by this issue while following `docs/02_SHARED_CONTRACTS.md` and `docs/03_ARCHITECTURE_AND_SAFETY.md`.

## Acceptance criteria
Virtual balances + order adapter written from scratch; atomic one-claim-per-plan; bounded limit; queryable order by clientOrderId; accepted != filled; no live trade endpoint.

## PR requirements
- Link to this issue and provide actual test commands/results.
- Preserve agreed types; discuss shared schema or lockfile edits with other developer first.
- No production financial credentials, no live-money trading, no private sponsor access links.
- Attach truthful evidence of failure/success where applicable.
