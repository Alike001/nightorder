# `@nightorder/telegram`

Telegram-facing instruction workflow for NightOrder's paper-only BTC/USDT
prototype. It is transport-neutral: `apps/worker` can translate Telegram Bot API
updates into `TelegramMessage` values and send returned text to the same chat.

## Safety boundary

- Every message is checked against a server-side Telegram user-ID allowlist.
- Natural-language model output is untrusted and parsed before the shared
  `@nightorder/domain` instruction schema accepts it.
- Missing or invalid asset, side, amount, trigger, limit, or expiry terms cause
  deterministic clarification. They are never defaulted by the workflow.
- Approval requires the owner to repeat the exact plan ID, revision, and SHA-256
  digest shown in the preview.
- Telegram only persists plans and cancellation intent. It has no execution port
  and cannot submit an order.
- Status text distinguishes approval, acceptance/open, simulated paper fill,
  rejection, cancellation request, confirmed cancellation, and uncertainty.

## Real LLM adapter

Construct `OpenAIInstructionInterpreter` with a server-side API key and an
explicit model name. Do not send the key through Telegram or place it in source,
logs, traces, or committed environment files.

The adapter uses the OpenAI Responses API structured-output parser with Zod. A
null, incomplete, refused, or invalid response fails closed and creates no plan.

## Persistence integration

`TelegramPlanRepository` extends the frozen domain `PlanRepository` with:

- owner-scoped plan listing;
- optimistic, validated state persistence;
- atomic digest-and-revision approval; and
- atomic owner-and-revision cancellation.

The worker's durable repository adapter must implement those operations in one
transaction. `InMemoryTelegramPlanRepository` and
`FixturePaperExecutionAdapter` are labeled development/test fixtures only.

## Tracing

Pass a `TelegramTraceSink` to connect future Neatlogs instrumentation. Trace
events intentionally omit natural-language message text and credentials, and a
trace backend failure cannot change authorization or persistence behavior.

## Checks

```sh
pnpm --filter @nightorder/telegram typecheck
pnpm --filter @nightorder/telegram test
pnpm --filter @nightorder/telegram build
```
