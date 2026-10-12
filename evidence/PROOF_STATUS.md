# P0 proof run status

**Last reproducibility check:** 2026-10-12 · **Classification:** local PAPER integration evidence with deterministic fixtures. These files do not represent production trades or live market activity. The integrated Telegram/live-market worker is described separately in the root README; these three records remain fixture proofs.

Reproduce and refresh the sanitized records with:

```sh
pnpm proof:runs
```

| Required scenario               | Record                        | Observed result                                                                                                                          | Scope limit                                                                                                                                                 |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preapproved fixture PAPER order | [run-a.json](runs/run-a.json) | One durable `NEW` order and attempt; independent journal readback passed; filled quantity remains zero.                                  | The plan is a preapproved test fixture; there is no Telegram owner confirmation or live quote path.                                                         |
| Unsafe refusal                  | [run-b.json](runs/run-b.json) | Limit above the approved maximum was rejected; zero order/attempt rows and balances unchanged.                                           | Exercises the deterministic execution guard directly.                                                                                                       |
| Commit then timeout             | [run-c.json](runs/run-c.json) | Timeout injected after SQLite commit; scripted fixture selected journal/readback diagnostics; one order remained; journal checks passed. | The model is scripted, the timeout is deliberately injected, and trace events are in memory. This does not prove live model behavior or Neatlogs ingestion. |

The JSON records include the actual local SQLite order IDs and checks from this run. Re-running creates new IDs and timestamps. No exchange credentials or user data were used.

## Remaining gates for Issue #12

- These fixture records do not exercise Telegram transport, live Gemini inference, or live-model recovery. A separate October 12 live PAPER capture is summarized in the root README.
- The run-c diagnostic model is scripted; its outcome is not a live incident. It tests recovery behavior against persisted SQLite evidence.
- These records do not include Neatlogs dashboard traces or a before/after evaluation. The team supplied genuine Neatlogs screenshots separately; no public trace URL is included here.
- [Entire checkpoint notes](ENTIRE.md) document a real Codex session and checkpoint; the underlying Entire project is private.
- cfo.ai inputs remain a planning draft in [business/cfo-ai-model-draft.md](../business/cfo-ai-model-draft.md); there is no cfo.ai project/export.
- Demo/video and submission completion are tracked in Issue #12; fixture proofs alone do not complete that issue.

The integrated proof runner is on `main`. Issue #12 remains open until the remaining demo review, cfo.ai project/export, and public submission evidence are complete.
