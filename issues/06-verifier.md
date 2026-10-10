# [P0] Independently verify guards and order state

**Owner:** B  
**Depends on:** 01-contracts; fixture port  
**Priority:** P0

## Objective
Implement the minimum behavior described by this issue while following `docs/02_SHARED_CONTRACTS.md` and `docs/03_ARCHITECTURE_AND_SAFETY.md`.

## Acceptance criteria
Verifier reads approved plan and order journal/adapter independently; checks price/amount/expiry/duplicate counts; outputs VERIFIED/BLOCKED/UNCERTAIN; never trusts agent text.

## PR requirements
- Link to this issue and provide actual test commands/results.
- Preserve agreed types; discuss shared schema or lockfile edits with other developer first.
- No production financial credentials, no live-money trading, no private sponsor access links.
- Attach truthful evidence of failure/success where applicable.
