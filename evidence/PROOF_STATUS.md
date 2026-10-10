# P0 proof run status

**Generated:** 2026-10-10 · **Classification:** local PAPER integration evidence with deterministic fixtures. These files do not represent production trades or live market activity.

Reproduce and refresh the sanitized records with:

```sh
pnpm proof:runs
```

| Required scenario      | Record                        | Observed result                                                                                                                          | Scope limit                                                                                                                                                 |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized PAPER order | [run-a.json](runs/run-a.json) | One durable `NEW` order and attempt; independent journal readback passed; filled quantity remains zero.                                  | Exercises the paper adapter directly; no Telegram or live quote path.                                                                                       |
| Unsafe refusal         | [run-b.json](runs/run-b.json) | Limit above the approved maximum was rejected; zero order/attempt rows and balances unchanged.                                           | Exercises the deterministic execution guard directly.                                                                                                       |
| Commit then timeout    | [run-c.json](runs/run-c.json) | Timeout injected after SQLite commit; scripted fixture selected journal/readback diagnostics; one order remained; journal checks passed. | The model is scripted, the timeout is deliberately injected, and trace events are in memory. This does not prove live model behavior or Neatlogs ingestion. |

The JSON records include the actual local SQLite order IDs and checks from this run. Re-running creates new IDs and timestamps. No exchange credentials or user data were used.

## Remaining gates for Issue #12

- Telegram instruction/approval/cancellation flow is not integrated.
- The standalone `packages/verifier` implementation is not wired; the records use a local journal readback check.
- No live OpenAI recovery run is claimed. `OPENAI_API_KEY` and a selected diagnostic model were not available for this run.
- No Neatlogs project trace or same-fixture before/after evaluation is included. In-memory events are not Neatlogs evidence.
- Entire checkpoint evidence exists separately in [PR #14](https://github.com/Alike001/nightorder/pull/14).
- cfo.ai model inputs are drafted in [PR #21](https://github.com/Alike001/nightorder/pull/21), but there is no cfo.ai project or export yet.
- A <=3 minute demo and final public submission do not exist yet.

This PR advances the local proof runner and keeps Issue #12 open until the missing integration and sponsor artifacts are actually available.
