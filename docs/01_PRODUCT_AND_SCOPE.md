# 01 · Locked product and 30-second explanation

**Working name**: NightOrder. **Track**: Build an agent that works (literally). **Team**: Bravo, two developers.

## Judge pitch
A trader sends an exact buy or sell instruction to Telegram before going offline. NightOrder confirms the limits, monitors fresh market prices, executes a permitted **paper/testnet** order when the condition is satisfied, investigates execution failures, and verifies the resulting order. The trader returns to an evidence-backed report, not a promise that an order must have filled.

Example (not live price): "Buy up to 50 USDT of BTC/USDT only if executable ask <= 60,000 USDT/BTC; limit price <= 60,000; expire at 07:00 Africa/Lagos." Do not auto-execute ambiguous or unapproved instructions.

## Hard question: Why AI?
**It is NOT needed for a price threshold or limit order**, which exchanges already support. AI is appropriate for conversational interpretation and when an order result is **unexpected**: select diagnostic tools, inspect stale feeds, rejection reasons or uncertain network outcomes, choose a safe next step and explain evidence. We must compare the agent with a non-AI deterministic baseline and show a real tool-driven recovery. A deterministic controller still enforces all risk bounds.

## Build scope P0
1. One trader/account, BTC/USDT spot only, virtual assets only, Telegram Bot API and explicit confirmation.
2. Live public best bid/ask quotes; test fixture feed permitted for reproducible tests and prominently labeled.
3. Deterministic watcher: evaluate trigger while trader is away (service, not a browser tab).
4. Persist original instruction, normalized immutable approved plan, order attempt journal and user cancellation.
5. Original PAPER execution adapter or, if immediately accessible, Binance Spot Testnet adapter. Testnet is optional and time-boxed to 45–60 min. PAPER may never be called live trading.
6. One bounded AI investigative agent, an execution guard independent of LLM, and an independent readback verifier.
7. Telegram accurate report, compact dashboard/proof route, traces and published engineering evidence.
8. Neatlogs, Entire, cfo.ai: mandatory.

## Explicit exclusions
Real funded trading; live keys; leverage or derivatives; trade recommendation or predictive strategy; profitable trading claims; multi-tenant user management; copy trading; arbitrary natural-language portfolio control; multiple AI agents; 10 cryptocurrency pairs; full graphical exchange terminal; trading on behalf of other people.

## Distinguish three states
- `ARMED`: instruction stored, no order yet.
- `ORDER_ACCEPTED`: execution adapter acknowledged order, **not necessarily filled**.
- `FILLED`: independent readback confirms a fill (paper simulated fill must be labeled **SIMULATED**).

## Stop rules
- No landing-page polish before an approved plan reaches a queryable order record.
- If external exchange testnet blocks progress >60min, use labeled original paper adapter.
- Never disguise test inputs as real market movement, or describe injected faults as spontaneous incidents.
- Do not submit third-party project code as new hackathon work.
