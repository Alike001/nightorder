import type {
  MarketQuote,
  OrderAttempt,
  Side,
  Symbol,
  ToolResult,
  TradePlan,
  VerificationResult,
  VirtualBalances,
} from "./schemas.js";

export interface MarketDataPort {
  currentQuote(symbol: Symbol): Promise<ToolResult<MarketQuote>>;
}

export interface SubmitApprovedOrderInput {
  clientOrderId: string;
  planId: string;
  symbol: Symbol;
  side: Side;
  quantity: string;
  limitPrice: string;
}

export interface OrderStatusResult {
  orderId: string;
  status: string;
}

export interface OrderReadbackResult extends OrderStatusResult {
  filledQuantity: string;
}

/** A virtual, original-paper adapter only. Implementations must not route live funds. */
export interface ExecutionPort {
  readonly mode: "PAPER";
  virtualBalances(): Promise<ToolResult<VirtualBalances>>;
  submitApprovedOrder(input: SubmitApprovedOrderInput): Promise<ToolResult<OrderStatusResult>>;
  findOrderByClientId(clientOrderId: string): Promise<ToolResult<OrderReadbackResult>>;
  requestCancel(clientOrderId: string): Promise<ToolResult<{ status: string }>>;
}

export interface PlanRepository {
  createDraft(plan: TradePlan): Promise<void>;
  approveExact(planId: string, ownerId: string, expectedHash: string): Promise<ToolResult<TradePlan>>;
  claimForExecution(planId: string, expectedRevision: number, operationId: string): Promise<ToolResult<OrderAttempt>>;
  loadPlan(planId: string): Promise<TradePlan | null>;
  loadAttempt(planId: string): Promise<OrderAttempt | null>;
  recordObservation(planId: string, event: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface VerificationPort {
  verify(planId: string): Promise<VerificationResult>;
}
