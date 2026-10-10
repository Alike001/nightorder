# Original PAPER execution adapter

`SqlitePaperExecutionAdapter` is a local, durable implementation of the documented execution port. Supply a `PlanRepository.loadPlan` compatible reader and an explicit pair of virtual BTC/USDT balances. The database stores balances, accepted paper orders and acknowledged `ORIGINAL_PAPER` attempts in SQLite transactions.

The adapter accepts only an approved `PAPER` plan in `SUBMITTING` state. It checks BTCUSDT, side, expiry, exact approved quantity or quote budget, and the plan's worst allowed limit. One order and one attempt per plan are enforced by SQLite uniqueness constraints inside an immediate transaction. BUY orders reserve USDT at limit price; SELL orders reserve BTC. Cancellation releases the reservation. `NEW` means accepted and resting; this adapter does not simulate fills, so readback reports zero filled quantity until a separate fill model is added.

There is no exchange endpoint or live-money code in this package. Trigger evaluation and the atomic plan state claim belong to the worker/repository boundary. This adapter's unique plan journal is an additional at-most-one-order guard.

The implementation uses Node's built-in `node:sqlite`, available under the workspace's Node 22.14+ engine. Node 22 currently labels that API experimental and emits a runtime warning; see the [Node.js SQLite API status](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html). Use a private local database path and do not commit database files.
