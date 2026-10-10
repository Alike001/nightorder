import {
  cancelRequestResultSchema,
  orderReadbackResultSchema,
  orderStatusResultSchema,
  submitApprovedOrderInputSchema,
  venueStatusSchema,
  virtualBalancesSchema,
  type AcceptedVenueStatus,
  type CancelRequestResult,
  type ExecutionPort,
  type OrderReadbackResult,
  type OrderStatusResult,
  type SubmitApprovedOrderInput,
  type ToolResult,
  type VenueStatus,
  type VirtualBalances,
} from '@nightorder/domain';

interface FixtureOrder {
  readonly orderId: string;
  readonly request: SubmitApprovedOrderInput;
  status: VenueStatus;
  filledQuantity: string;
  cancellationRequested: boolean;
}

/** Labeled, in-memory PAPER adapter. The Telegram workflow never calls submit on it. */
export class FixturePaperExecutionAdapter implements ExecutionPort {
  readonly mode = 'PAPER' as const;
  private readonly orders = new Map<string, FixtureOrder>();
  private sequence = 0;

  constructor(
    private readonly balances: VirtualBalances = {
      BTC: '1',
      USDT: '100000',
    },
    private readonly acceptedStatus: AcceptedVenueStatus = 'NEW',
  ) {
    virtualBalancesSchema.parse(balances);
    orderStatusResultSchema.shape.status.parse(acceptedStatus);
  }

  get submissionCount(): number {
    return this.orders.size;
  }

  async virtualBalances(): Promise<ToolResult<VirtualBalances>> {
    return this.success(virtualBalancesSchema.parse(this.balances));
  }

  async submitApprovedOrder(
    inputValue: SubmitApprovedOrderInput,
  ): Promise<ToolResult<OrderStatusResult>> {
    const input = submitApprovedOrderInputSchema.parse(inputValue);
    const existing = this.orders.get(input.clientOrderId);
    if (existing) {
      return this.success(
        orderStatusResultSchema.parse({
          orderId: existing.orderId,
          status:
            existing.status === 'PARTIALLY_FILLED' ||
            existing.status === 'FILLED'
              ? existing.status
              : 'NEW',
        }),
      );
    }

    this.sequence += 1;
    const orderId = `fixture-paper-order-${this.sequence}`;
    this.orders.set(input.clientOrderId, {
      orderId,
      request: structuredClone(input),
      status: this.acceptedStatus,
      filledQuantity: this.acceptedStatus === 'FILLED' ? input.quantity : '0',
      cancellationRequested: false,
    });
    return this.success(
      orderStatusResultSchema.parse({
        orderId,
        status: this.acceptedStatus,
      }),
    );
  }

  async findOrderByClientId(
    clientOrderId: string,
  ): Promise<ToolResult<OrderReadbackResult>> {
    const order = this.orders.get(clientOrderId);
    if (!order) return this.notFound();
    return this.success(
      orderReadbackResultSchema.parse({
        orderId: order.orderId,
        status: order.status,
        filledQuantity: order.filledQuantity,
      }),
    );
  }

  async requestCancel(
    clientOrderId: string,
  ): Promise<ToolResult<CancelRequestResult>> {
    const order = this.orders.get(clientOrderId);
    if (!order) return this.notFound();
    order.cancellationRequested = true;
    return this.success(
      cancelRequestResultSchema.parse({ status: 'CANCEL_REQUESTED' }),
    );
  }

  /** Test-only readback control; cancellation requests do not call this automatically. */
  reconcile(
    clientOrderId: string,
    statusInput: VenueStatus,
    filledQuantity: string,
  ): void {
    const order = this.orders.get(clientOrderId);
    if (!order) throw new Error(`Fixture order ${clientOrderId} not found`);
    const status = venueStatusSchema.parse(statusInput);
    orderReadbackResultSchema.parse({
      orderId: order.orderId,
      status,
      filledQuantity,
    });
    order.status = status;
    order.filledQuantity = filledQuantity;
  }

  wasCancellationRequested(clientOrderId: string): boolean {
    return this.orders.get(clientOrderId)?.cancellationRequested ?? false;
  }

  private success<T>(data: T): ToolResult<T> {
    return {
      ok: true,
      data: structuredClone(data),
      evidenceId: `fixture-paper-evidence-${this.sequence}`,
    };
  }

  private notFound<T>(): ToolResult<T> {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Fixture paper order not found',
      retrySafe: false,
      evidenceId: `fixture-paper-evidence-${this.sequence}`,
    };
  }
}
