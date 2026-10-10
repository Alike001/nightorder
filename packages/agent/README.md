# Bounded recovery agent

`BoundedRecoveryAgent` handles a failed PAPER write by asking a model to choose up to three read-only diagnostics: read the durable attempt journal, query the adapter by the original `clientOrderId`, or run the independent verifier. It has no order submission, retry, cancellation, exchange credential, shell, or arbitrary-network tool. A fourth model turn has tools disabled so the model can inspect the collected results without extending the tool budget.

The agent always runs the independent verifier after model diagnostics. Only a verified result with non-empty all-true checks and at least one completed model-selected diagnostic returns `VERIFIED`. Any uncertainty, blocked check, malformed model call, provider failure, or trace failure requests a persisted `NEEDS_HUMAN` transition. The agent never resubmits the order.

Live model calls use the OpenAI Responses API via `OPENAI_API_KEY` and the explicitly configured `NIGHTORDER_DIAGNOSTIC_MODEL`. There is no implicit model selection and no request is made until recovery runs. Calls set `store: false`, disable parallel tools, cap output tokens and use an 8-second HTTP timeout. Responses function calling follows the [official OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).

The plan repository adapter must implement `markNeedsHuman` in addition to the currently documented read/observation methods. The shared contract owner should add or confirm that transition in the contract PR. Until then, this package's port documents the required integration explicitly.
