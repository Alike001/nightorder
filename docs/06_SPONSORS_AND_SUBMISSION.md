# 06 · Mandatory partner tools and submission

## Neatlogs · IN THE APPLICATION

Owner: Developer B (SDK), Developer A adds spans to worker/agent. Set up https://app.neatlogs.com and follow https://neatlogs.com/hackathon/neatlogs-setup-guide.html . TypeScript package `neatlogs`; SDK guide https://docs.neatlogs.com/sdk/typescript .

Use `await init(...)`, workflow/agent/tool/guardrail spans, and a provider-specific wrapper where supported. Trace actual Telegram plan interpretation, model calls, investigative tools, order guard refusal, uncertain-write recovery, readback verifier, and terminal result. Redact secrets and sensitive free-text.

**Proof requirement:** actual trace appears in dashboard, an identified failing run, changed code, a successful retest with measurable differences and accessible trace links/screenshots. Installing SDK alone does not count. The user provided a previous 403 wizard error; if it persists, check SDK key/project and organizer Discord; do not fabricate traces.

## Entire · DURING CODING

Owner: Developer A (installation and first checkpoint), B enables it in own Codex sessions. Official guide https://hack.entire.io/neathacks-2026/ . Both use _actual_ Codex development sessions and produce real checkpoint IDs/link, GitHub-connected repository and inspectable Trails. Entire is **not** a Telegram notification service and does not authorize trades. Verify current CLI command syntax from guide or `entire --help` rather than guessing.

**Proof requirement:** repository checkpoint with coding context, commit/PR referencing work and linked proof. Neither a screenshot of a CLI installation nor a manufactured checkpoint counts.

## cfo.ai · BUSINESS PLANNING, NOT LIVE ORDER RISK

Owners: both. Use https://cfo.ai/neathacks . Signup requires payment card; follow organizer instructions, cancel in Billing and verify billing state. Organizer says credits added for team. Do not treat cfo.ai as a trading risk oracle or connect it to each order.

Business model inputs: e.g. subscription tiers, active paying users, MAU to paid conversion assumptions, Telegram+EC2/server cost, market-data/API charges, LLM inference tokens/cost per incident, customer support, payment processing, churn sensitivity, gross margin and 6–12 month runway.

**Evidence:** The public NightOrder cfo.ai model is at [cfo.ai/s/HW7EXJ-uQPEYOLdM](https://cfo.ai/s/HW7EXJ-uQPEYOLdM), with Assumptions, Operating Model, Financial Model, and Decision Dashboard exports. The model includes documented pricing, customer, infrastructure, AI, and operating assumptions, scenario analysis, and runway. All financial projections are hypothetical; NightOrder has no paying customers and these are not actuals or validated forecasts. Exports are in the cfo.ai project, not committed here. Do not show account or billing details in the demo.

## Other sponsors / AWS

AWS $25 credit is optional, provided to the checked-in team, approved EC2/Lambda/IAM roles/load-balancers in us-east-1 only, one EC2 instance per team, use supplied VPC, volume <=50GB. Prefer inexpensive runtime and shut down when unnecessary. Private access URL must never be committed, pasted in PRs, or shown on video. Consider credential rotation if link exposed.
Crustdata is optional and not relevant to trading execution; do not add it just for sponsor mentions.

## Official submission checklist

- Public GitHub repository with original code committed during event.
- Demo video **<= 3 minutes** showing actual task completed and explicitly Neatlogs, Entire, cfo.ai.
- Public X quote-post of official submission post during designated Oct 12 window; opening X draft isn't submission.
- Working app link if deployed; accessible trace/checkpoint evidence; [public cfo.ai model](https://cfo.ai/s/HW7EXJ-uQPEYOLdM) and its exported plan views; build-in-public posts tagged `#neatHack`.
- Honest statement of PAPER vs TESTNET, induced faults, order accepted vs filled, remaining limitations.
- Actual three-run evidence and before/after measurements.

Source: https://neatlogs.com/hackathon . Check organizers' Discord for changes.
