# [P0] Bounded AI diagnostics and timeout-after-commit recovery

**Owner:** A  
**Depends on:** 02-runtime-quotes + 03-paper-execution  
**Priority:** P0

## Objective
Implement the minimum behavior described by this issue while following `docs/02_SHARED_CONTRACTS.md` and `docs/03_ARCHITECTURE_AND_SAFETY.md`.

## Acceptance criteria
Real model selects diagnostic tools based on failed write; journal readback; zero duplicate orders; bounded retries and NEEDS_HUMAN if still uncertain; tracing hook calls.

## PR requirements
- Link to this issue and provide actual test commands/results.
- Preserve agreed types; discuss shared schema or lockfile edits with other developer first.
- No production financial credentials, no live-money trading, no private sponsor access links.
- Attach truthful evidence of failure/success where applicable.
