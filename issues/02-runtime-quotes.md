# [P0] Build durable watcher and price-feed adapter

**Owner:** A  
**Depends on:** 01-contracts (can prototype with fixture)  
**Priority:** P0

## Objective
Implement the minimum behavior described by this issue while following `docs/02_SHARED_CONTRACTS.md` and `docs/03_ARCHITECTURE_AND_SAFETY.md`.

## Acceptance criteria
Worker runs while browser closed; live bid/ask or labeled fixture; stale quote rejected; armed plan survives worker restart and expires in UTC.

## PR requirements
- Link to this issue and provide actual test commands/results.
- Preserve agreed types; discuss shared schema or lockfile edits with other developer first.
- No production financial credentials, no live-money trading, no private sponsor access links.
- Attach truthful evidence of failure/success where applicable.
