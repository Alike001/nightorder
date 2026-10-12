# Market data worker

The worker polls public Binance Spot BTCUSDT best bid/ask data outside the browser. It stores approved armed plans in SQLite (`NIGHTORDER_WORKER_DB`, default `nightorder-worker.sqlite`) using WAL and full synchronous writes so a restart can reload them. Keep this database on persistent local or service storage.

`SqliteArmedPlanStore.saveArmedPlan` is the integration boundary for the plan repository. It accepts only an already approved `ARMED` plan with UTC ISO timestamps and a stable plan hash. The store preserves the plan, expires it against UTC time, rejects stale quotes for evaluation, and records a threshold crossing once as `TRIGGERED`.

The worker currently observes and records trigger state only. It has no order submission path; execution-controller and shared-contract integration remain separate work. A `TRIGGERED` record therefore requires downstream handling before any order could be considered.

Run the worker tests from this package with `pnpm --filter @nightorder/worker test` or from the workspace root with `pnpm test`.
