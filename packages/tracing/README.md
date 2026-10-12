# `@nightorder/tracing`

Neatlogs observability for NightOrder's PAPER-only workflows. The package uses
the genuine `neatlogs` TypeScript SDK and manual semantic spans. It never treats
telemetry success as trading authorization or execution evidence.

## SDK compatibility decision

This package pins `neatlogs` 1.1.28. The Neatlogs TypeScript documentation lists
`openai` 6.34.x as the verified `wrapOpenAI` baseline. NightOrder Telegram uses
`openai` 7.32.x, so this integration deliberately does **not** call
`wrapOpenAI`. The instruction-model operation is enclosed in a manual `AGENT`
span with message content, model input/output, and private reasoning omitted.

## Local configuration

Create a Neatlogs project and place its project key in your local shell or an
untracked `.env` loaded by the process:

```sh
export NEATLOGS_API_KEY='replace-with-your-project-key'
export NEATLOGS_WORKFLOW_NAME='nightorder-local'
```

Optional settings:

```sh
export NEATLOGS_ENABLED='false' # explicit no-op mode
export NEATLOGS_ENDPOINT='https://eu.ingest.neatlogs.com' # EU projects only
```

Never commit the key. An absent key or `NEATLOGS_ENABLED=false` returns a no-op
runtime. Initialization/export failures also fail open for application behavior
and are observable only through the optional `telemetryFailure` callback.

Initialize once and inject the returned sink into the Telegram workflow:

```ts
import { initializeNeatlogsFromEnvironment } from '@nightorder/tracing';
import { TelegramInstructionWorkflow } from '@nightorder/telegram';

const telemetry = await initializeNeatlogsFromEnvironment(process.env);
const workflow = new TelegramInstructionWorkflow({
  allowedUserIds,
  repository,
  interpreter,
  trace: telemetry.sink,
});

// Long-running worker shutdown hook: stop accepting work first.
await telemetry.shutdown(); // flushes, then shuts down once
```

Do not flush after every Telegram update. Long-running workers flush and shut
down once during graceful termination. Short-lived proof scripts must flush and
shut down in `finally`.

## Trace model and privacy

Each Telegram update generates an application `runId` and opens one `WORKFLOW`
root. Interpretation is `AGENT`, repository interactions are `TOOL`, and
authorization/validation decisions are `GUARDRAIL`. The `runId` is a NightOrder
correlation ID, **not** a claimed Neatlogs trace ID. Plans use a deterministic
one-way pseudonym; raw plan IDs, Telegram user/chat IDs, message content, API
keys, authorization tokens, prompts, and private reasoning are not attributes.

The SDK is configured with local masking as a second line of defense. Input and
output content are not passed to manual spans, and SDK log capture is disabled.

Watcher, recovery, and verifier owners can use the exported structural ports and
span builders without this package editing their runtime code:

- `MarketWatcherTraceSink`, `watcherWorkflowSpan`, `watcherGuardrailSpan`
- `RecoveryAgentTraceSink`, `recoveryAgentSpan`, `recoveryToolSpan`
- `IndependentVerifierTraceSink`, `verifierWorkflowSpan`,
  `verifierGuardrailSpan`

Generate one `runId` at the workflow boundary and reuse the same
`pseudonymousPlanId` on child spans.

## Evaluation harness

`compareIncidentEvaluators` runs baseline and improved evaluators over the exact
same ordered fixture IDs and reports numeric:

- unauthorized action count;
- duplicate order count (`max(orderCount - 1, 0)` per incident);
- verified outcome count;
- recovery success count and rate.

Run the reproducible fixture comparison with:

```sh
pnpm --filter @nightorder/tracing evaluate:fixtures
```

The checked-in comparison is fixture-based contract evidence only. It does not
prove a production recovery path or Neatlogs ingestion.

## Proving genuine ingestion

First run the SDK's network-free local diagnostic:

```sh
pnpm --filter @nightorder/tracing exec neatlogs doctor --local --json
```

With `NEATLOGS_API_KEY` configured, run the authenticated readback probe:

```sh
pnpm --filter @nightorder/tracing exec neatlogs doctor --probe --json
```

Then run an actual Telegram workflow using `NeatlogsTelegramTraceSink`, call
`flush()` for a short-lived proof process (or graceful `shutdown()` for the
worker), and open the Neatlogs dashboard. Filter by the configured workflow name
and the `nightorder_run_id` attribute. Confirm the `WORKFLOW` root contains the
expected `AGENT`, `TOOL`, and `GUARDRAIL` children. Record the dashboard's real
trace ID/link only after viewing or reading it back; never substitute the
NightOrder run ID.

A local Doctor pass proves controlled in-process capture, while a probe proves
the Doctor trace's finalized readback. Neither alone proves the real Telegram
workflow appeared in the dashboard.
