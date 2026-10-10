# 02 · Shared contracts: freeze before parallel implementation

**Contract owner for first PR: Developer B**. Developer A reviews in first 30 minutes. Changes thereafter require a dedicated contract PR and both approvals. Each component may stub the other behind these types. Use TypeScript + Zod; no floating-point arithmetic for monetary accounting (decimal strings or fixed integer units).

## IDs and time
- IDs UUIDv7/UUID or stable strings; UTC ISO timestamps; user local timezone stored as IANA name.
- Quote values, base quantities, and quote budgets use **decimal strings** to preserve precision.
- `ownerId` is a Telegram allowlisted user ID mapped to local identity. Only the approved owner may confirm or cancel.
- `planHash` is SHA-256 of canonical immutable authorization fields; approval captures its digest and UTC time.

## Types (design contracts, not implemented code)

```ts
type Mode = 'PAPER' | 'TESTNET';
type Side = 'BUY' | 'SELL';
type PlanState =
  | 'DRAFT' | 'AWAITING_CONFIRMATION' | 'ARMED' | 'TRIGGERED'
  | 'SUBMITTING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED'
  | 'REJECTED' | 'UNCERTAIN' | 'CANCEL_REQUESTED'
  | 'CANCELLED' | 'EXPIRED' | 'NEEDS_HUMAN';

type TradePlan = {
  id: string; ownerId: string; symbol: 'BTCUSDT'; side: Side;
  quoteBudgetUsdt?: string; baseQuantityBtc?: string;
  triggerPrice: string; triggerOperator: 'ASK_LTE' | 'BID_GTE';
  limitPrice: string; expiresAtUtc: string; timezone: string;
  mode: Mode; planHash: string; approvedAtUtc?: string;
  state: PlanState; revision: number;
};

type MarketQuote = {
  symbol: 'BTCUSDT'; bestBid: string; bestAsk: string;
  observedAtUtc: string; receivedAtUtc: string; source: string;
  kind: 'LIVE_PUBLIC' | 'TEST_FIXTURE';
};

type OrderAttempt = {
  id: string; planId: string; operationId: string; clientOrderId: string;
  requestDigest: string; remoteOrderId?: string;
  state: 'PREPARED' | 'SENDING' | 'UNCERTAIN' | 'ACKNOWLEDGED' | 'RECONCILED';
  venueStatus?: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  evidenceSource: 'ORIGINAL_PAPER' | 'BINANCE_TESTNET';
  createdAtUtc: string; reconciledAtUtc?: string;
};

type ToolResult<T> =
  | { ok: true; data: T; evidenceId: string }
  | { ok: false; code: 'STALE_QUOTE' | 'EXPIRED' | 'UNAUTHORIZED' | 'INSUFFICIENT_BALANCE' | 'REJECTED' | 'TIMEOUT' | 'RATE_LIMIT' | 'NETWORK' | 'NOT_FOUND' | 'AMBIGUOUS'; message: string; retrySafe: boolean; evidenceId: string };
```

## Required interface ports

```ts
interface MarketDataPort {
  currentQuote(symbol: 'BTCUSDT'): Promise<ToolResult<MarketQuote>>;
}
interface ExecutionPort {
  virtualBalances(): Promise<ToolResult<Record<'BTC'|'USDT', string>>>;
  submitApprovedOrder(input: {
    clientOrderId: string; planId: string; symbol: 'BTCUSDT';
    side: Side; quantity: string; limitPrice: string;
  }): Promise<ToolResult<{ orderId: string; status: string }>>;
  findOrderByClientId(clientOrderId: string): Promise<ToolResult<{ orderId: string; status: string; filledQuantity: string }>>;
  requestCancel(clientOrderId: string): Promise<ToolResult<{ status: string }>>;
}
interface PlanRepository {
  createDraft(plan: TradePlan): Promise<void>;
  approveExact(planId: string, ownerId: string, expectedHash: string): Promise<ToolResult<TradePlan>>;
  claimForExecution(planId: string, expectedRevision: number, operationId: string): Promise<ToolResult<OrderAttempt>>;
  loadPlan(planId: string): Promise<TradePlan | null>;
  loadAttempt(planId: string): Promise<OrderAttempt | null>;
  recordObservation(planId: string, event: object): Promise<void>;
}
interface VerificationPort {
  verify(planId: string): Promise<{ result: 'VERIFIED'|'BLOCKED'|'UNCERTAIN'; checks: Record<string, boolean>; evidenceIds: string[] }>;
}
```

## Boundary rules
- Telegram calls `PlanRepository` and submits commands; it never writes orders directly.
- Market watcher calls `MarketDataPort`, evaluates constraints in `packages/domain`, then calls the guarded execution controller, never `ExecutionPort` directly.
- Execution controller uses `PlanRepository.claimForExecution` atomically before `ExecutionPort.submitApprovedOrder`.
- The agent receives redacted read-only diagnostic tools and guarded action requests; never raw exchange API keys or unrestricted network calls.
- Verifier independently loads plan, order attempt and adapter status. It does NOT trust the agent's "success" claim.
- Every module is replaceable with a fixture adapter in tests without changing the contract.

## First 30-minute handshake
1. Agree exact property names, symbols, decimal representation, timezone, default expiry, trade side semantics and error codes.
2. Developer B merges contract-only PR (`packages/domain`) and exports Zod schemas.
3. Both developers work in parallel using deterministic fixtures; no cross-folder edits without PR review.
