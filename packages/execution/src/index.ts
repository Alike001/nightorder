import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  ExecutionPort,
  OrderAttempt,
  OrderReadbackResult,
  OrderStatusResult,
  SubmitApprovedOrderInput,
  ToolErrorCode,
  ToolResult,
  TradePlan,
  VirtualBalances,
  VenueStatus,
} from '@nightorder/domain';
import type { VerificationEvidenceSnapshot } from '@nightorder/domain';
import {
  mapPaperCancelAcknowledgement,
  mapSqlitePaperOrderAttempt,
  persistentPaperOrderSchema,
  orderReadbackToolResultSchema,
  submitApprovedOrderResultSchema,
  tradePlanSchema,
  virtualBalancesSchema,
} from '@nightorder/domain';

export type PaperSide = 'BUY' | 'SELL';
/** Structural projection of the frozen TradePlan contract needed by the paper adapter. */
export type ApprovedPaperPlan = TradePlan;

export interface ApprovedPlanReader {
  loadPlan(planId: string): Promise<ApprovedPaperPlan | null>;
  /** Evidence IDs must come from persisted plan and authorization records. */
  loadPlanEvidence?(
    planId: string,
  ): Promise<VerificationEvidenceSnapshot['plan'] | undefined>;
  loadAuthorizationEvidence?(
    planId: string,
  ): Promise<VerificationEvidenceSnapshot['authorization'] | undefined>;
}

export type PaperOrderRequest = SubmitApprovedOrderInput;

export type PaperErrorCode = ToolErrorCode;
export type PaperResult<T> = ToolResult<T>;

export type PaperBalances = VirtualBalances;

export interface PaperOrder {
  orderId: string;
  planId: string;
  clientOrderId: string;
  symbol: 'BTCUSDT';
  side: PaperSide;
  quantity: string;
  limitPrice: string;
  status: VenueStatus;
  filledQuantity: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  requestDigest: string;
}

export type PaperOrderAttempt = OrderAttempt;

export interface PaperExecutionOptions {
  databasePath: string;
  initialBalances: PaperBalances;
  now?: () => Date;
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const utcTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

function isUtcTimestamp(value: string): boolean {
  const match = utcTimestampPattern.exec(value);
  if (!match) return false;
  const milliseconds = (match[2] ?? '').padEnd(3, '0');
  const canonical = `${match[1]}.${milliseconds || '000'}Z`;
  try {
    return new Date(value).toISOString() === canonical;
  } catch {
    return false;
  }
}

function parsePositiveDecimal(value: string, name: string): Decimal {
  if (!decimalPattern.test(value)) {
    throw new Error(`${name} must be a positive decimal string`);
  }
  const [whole = '', fractional = ''] = value.split('.');
  const coefficient = BigInt(`${whole}${fractional}`);
  if (coefficient <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }
  return { coefficient, scale: fractional.length };
}

function parseNonNegativeDecimal(value: string, name: string): Decimal {
  if (/^0(?:\.0+)?$/.test(value))
    return {
      coefficient: 0n,
      scale: value.includes('.') ? value.length - value.indexOf('.') - 1 : 0,
    };
  return parsePositiveDecimal(value, name);
}

function scaled(value: Decimal, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

function compareDecimal(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = scaled(left, scale);
  const b = scaled(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { coefficient: scaled(left, scale) + scaled(right, scale), scale };
}

function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { coefficient: scaled(left, scale) - scaled(right, scale), scale };
}

function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
  return {
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  };
}

function formatDecimal(value: Decimal): string {
  const negative = value.coefficient < 0n;
  const absolute = negative ? -value.coefficient : value.coefficient;
  const digits = absolute.toString().padStart(value.scale + 1, '0');
  const whole = value.scale === 0 ? digits : digits.slice(0, -value.scale);
  const fractional =
    value.scale === 0 ? '' : digits.slice(-value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
}

function error<T>(
  code: PaperErrorCode,
  message: string,
  evidenceId = randomUUID(),
): PaperResult<T> {
  return { ok: false, code, message, retrySafe: false, evidenceId };
}

function asPaperOrder(row: Record<string, unknown>): PaperOrder {
  return {
    orderId: String(row.order_id),
    planId: String(row.plan_id),
    clientOrderId: String(row.client_order_id),
    symbol: 'BTCUSDT',
    side: row.side as PaperSide,
    quantity: String(row.quantity),
    limitPrice: String(row.limit_price),
    status: row.status as PaperOrder['status'],
    filledQuantity: String(row.filled_quantity ?? '0'),
    createdAtUtc: String(row.created_at_utc),
    updatedAtUtc: String(row.updated_at_utc),
    requestDigest: String(row.request_digest),
  };
}

function immediateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (cause) {
    database.exec('ROLLBACK');
    throw cause;
  }
}

/**
 * Durable, local PAPER-only ExecutionPort adapter. Orders are accepted as resting
 * NEW orders; this adapter never claims that an order filled.
 */
export class SqlitePaperExecutionAdapter implements ExecutionPort {
  readonly mode = 'PAPER' as const;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;

  constructor(
    private readonly plans: ApprovedPlanReader,
    options: PaperExecutionOptions,
  ) {
    this.database = new DatabaseSync(options.databasePath);
    this.now = options.now ?? (() => new Date());
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS virtual_balances (
        asset TEXT PRIMARY KEY CHECK (asset IN ('BTC', 'USDT')),
        initial_amount TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS paper_orders (
        order_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL UNIQUE,
        client_order_id TEXT NOT NULL UNIQUE,
        symbol TEXT NOT NULL CHECK (symbol = 'BTCUSDT'),
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        quantity TEXT NOT NULL,
        limit_price TEXT NOT NULL,
        reserved_amount TEXT NOT NULL,
        reserved_asset TEXT NOT NULL CHECK (reserved_asset IN ('BTC', 'USDT')),
        status TEXT NOT NULL CHECK (status IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')),
        filled_quantity TEXT NOT NULL DEFAULT '0',
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        request_digest TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS paper_attempts (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(plan_id),
        operation_id TEXT NOT NULL UNIQUE,
        client_order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(client_order_id),
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PREPARED', 'SENDING', 'UNCERTAIN', 'ACKNOWLEDGED', 'RECONCILED')),
        venue_status TEXT CHECK (venue_status IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')),
        evidence_source TEXT NOT NULL CHECK (evidence_source = 'ORIGINAL_PAPER'),
        created_at_utc TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(order_id),
        reconciled_at_utc TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS paper_cancel_acknowledgements (
        id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL REFERENCES paper_orders(client_order_id),
        status TEXT NOT NULL CHECK (status = 'CANCELED'),
        acknowledged_at_utc TEXT NOT NULL
      ) STRICT;
    `);

    this.migrateExistingSchema();

    const insertBalance = this.database.prepare(
      'INSERT OR IGNORE INTO virtual_balances (asset, initial_amount) VALUES (?, ?)',
    );
    insertBalance.run(
      'BTC',
      formatDecimal(
        parseNonNegativeDecimal(options.initialBalances.BTC, 'BTC balance'),
      ),
    );
    insertBalance.run(
      'USDT',
      formatDecimal(
        parseNonNegativeDecimal(options.initialBalances.USDT, 'USDT balance'),
      ),
    );
  }

  async virtualBalances(): Promise<PaperResult<PaperBalances>> {
    const initial = this.database
      .prepare('SELECT asset, initial_amount FROM virtual_balances')
      .all() as Array<{ asset: 'BTC' | 'USDT'; initial_amount: string }>;
    const available: PaperBalances = { BTC: '0', USDT: '0' };
    for (const asset of ['BTC', 'USDT'] as const) {
      const balance =
        initial.find((entry) => entry.asset === asset)?.initial_amount ?? '0';
      const reservedRows = this.database
        .prepare(
          "SELECT reserved_amount FROM paper_orders WHERE reserved_asset = ? AND status = 'NEW'",
        )
        .all(asset) as Array<{ reserved_amount: string }>;
      const reserved = reservedRows.reduce(
        (sum, row) =>
          addDecimal(
            sum,
            parseNonNegativeDecimal(row.reserved_amount, 'reserved amount'),
          ),
        { coefficient: 0n, scale: 0 },
      );
      available[asset] = formatDecimal(
        subtractDecimal(
          parseNonNegativeDecimal(balance, `${asset} balance`),
          reserved,
        ),
      );
    }
    return {
      ok: true,
      data: virtualBalancesSchema.parse(available),
      evidenceId: randomUUID(),
    };
  }

  async submitApprovedOrder(
    request: PaperOrderRequest,
  ): Promise<PaperResult<OrderStatusResult>> {
    const plan = await this.plans.loadPlan(request.planId);
    if (!plan)
      return error('NOT_FOUND', 'No approved plan exists for this order.');
    let planIsValid = false;
    try {
      planIsValid = tradePlanSchema.safeParse(plan).success;
    } catch {
      planIsValid = false;
    }
    if (!planIsValid) {
      return error(
        'REJECTED',
        'The persisted plan does not satisfy the domain contract.',
      );
    }
    const validation = this.validate(request, plan);
    if (validation) return validation;

    const quantity = parsePositiveDecimal(request.quantity, 'quantity');
    const limitPrice = parsePositiveDecimal(request.limitPrice, 'limitPrice');
    const notional = multiplyDecimal(quantity, limitPrice);
    const reserveAsset = request.side === 'BUY' ? 'USDT' : 'BTC';
    const reserveAmount = request.side === 'BUY' ? notional : quantity;
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          clientOrderId: request.clientOrderId,
          planId: request.planId,
          symbol: request.symbol,
          side: request.side,
          quantity: formatDecimal(quantity),
          limitPrice: formatDecimal(limitPrice),
          planHash: plan.planHash,
        }),
      )
      .digest('hex');
    const existing = this.findByClientId(request.clientOrderId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        return error(
          'AMBIGUOUS',
          'clientOrderId already belongs to a different request.',
        );
      }
      if (existing.status !== 'NEW') {
        return error('REJECTED', 'The existing paper order is no longer open.');
      }
      return submitApprovedOrderResultSchema.parse({
        ok: true,
        data: { orderId: existing.orderId, status: existing.status },
        evidenceId: existing.orderId,
      });
    }

    const createOrder = immediateTransaction(this.database, () => {
      const byPlan = this.database
        .prepare('SELECT order_id FROM paper_orders WHERE plan_id = ?')
        .get(request.planId);
      if (byPlan) return { kind: 'duplicate' as const };

      const initial = this.database
        .prepare('SELECT initial_amount FROM virtual_balances WHERE asset = ?')
        .get(reserveAsset) as { initial_amount: string } | undefined;
      if (!initial) return { kind: 'insufficient' as const };
      const reservedRows = this.database
        .prepare(
          "SELECT reserved_amount FROM paper_orders WHERE reserved_asset = ? AND status = 'NEW'",
        )
        .all(reserveAsset) as Array<{ reserved_amount: string }>;
      const alreadyReserved = reservedRows.reduce(
        (sum, row) =>
          addDecimal(
            sum,
            parseNonNegativeDecimal(row.reserved_amount, 'reserved amount'),
          ),
        { coefficient: 0n, scale: 0 },
      );
      const available = subtractDecimal(
        parseNonNegativeDecimal(
          initial.initial_amount,
          `${reserveAsset} balance`,
        ),
        alreadyReserved,
      );
      if (compareDecimal(available, reserveAmount) < 0)
        return { kind: 'insufficient' as const };

      const orderId = randomUUID();
      const createdAtUtc = this.now().toISOString();
      this.database
        .prepare(
          `INSERT INTO paper_orders (
            order_id, plan_id, client_order_id, symbol, side, quantity, limit_price,
            reserved_amount, reserved_asset, status, created_at_utc, updated_at_utc, request_digest
          ) VALUES (?, ?, ?, 'BTCUSDT', ?, ?, ?, ?, ?, 'NEW', ?, ?, ?)`,
        )
        .run(
          orderId,
          request.planId,
          request.clientOrderId,
          request.side,
          formatDecimal(quantity),
          formatDecimal(limitPrice),
          formatDecimal(reserveAmount),
          reserveAsset,
          createdAtUtc,
          createdAtUtc,
          requestDigest,
        );
      this.database
        .prepare(
          `INSERT INTO paper_attempts (
            id, plan_id, operation_id, client_order_id, request_digest, state,
            venue_status, evidence_source, created_at_utc, order_id
          ) VALUES (?, ?, ?, ?, ?, 'ACKNOWLEDGED', 'NEW', 'ORIGINAL_PAPER', ?, ?)`,
        )
        .run(
          randomUUID(),
          request.planId,
          `paper-order:${request.planId}`,
          request.clientOrderId,
          requestDigest,
          createdAtUtc,
          orderId,
        );
      return { kind: 'created' as const, orderId };
    });

    if (createOrder.kind === 'duplicate') {
      return error(
        'REJECTED',
        'This plan already has a paper order; a second order was not created.',
      );
    }
    if (createOrder.kind === 'insufficient') {
      return error(
        'INSUFFICIENT_BALANCE',
        `Insufficient virtual ${reserveAsset} balance.`,
      );
    }
    return submitApprovedOrderResultSchema.parse({
      ok: true,
      data: { orderId: createOrder.orderId, status: 'NEW' },
      evidenceId: createOrder.orderId,
    });
  }

  async findOrderByClientId(
    clientOrderId: string,
  ): Promise<PaperResult<OrderReadbackResult>> {
    const order = this.findByClientId(clientOrderId);
    if (!order)
      return error(
        'NOT_FOUND',
        'No paper order exists for this clientOrderId.',
      );
    return orderReadbackToolResultSchema.parse({
      ok: true,
      data: {
        orderId: order.orderId,
        status: order.status,
        filledQuantity: order.filledQuantity,
      },
      evidenceId: order.orderId,
    });
  }

  async requestCancel(
    clientOrderId: string,
  ): Promise<PaperResult<{ status: 'CANCEL_REQUESTED' }>> {
    const cancel = immediateTransaction(this.database, () => {
      const order = this.findByClientId(clientOrderId);
      if (!order) return null;
      const acknowledgedAt = this.now().toISOString();
      if (order.status === 'NEW') {
        this.database
          .prepare(
            "UPDATE paper_orders SET status = 'CANCELED', updated_at_utc = ? WHERE order_id = ?",
          )
          .run(acknowledgedAt, order.orderId);
        this.database
          .prepare(
            "UPDATE paper_attempts SET state = 'RECONCILED', venue_status = 'CANCELED', reconciled_at_utc = ? WHERE plan_id = ?",
          )
          .run(acknowledgedAt, order.planId);
      }
      const acknowledgementId = randomUUID();
      this.database
        .prepare(
          "INSERT INTO paper_cancel_acknowledgements (id, client_order_id, status, acknowledged_at_utc) VALUES (?, ?, 'CANCELED', ?)",
        )
        .run(acknowledgementId, clientOrderId, acknowledgedAt);
      return { orderId: order.orderId, acknowledgementId };
    });
    if (!cancel)
      return error(
        'NOT_FOUND',
        'No paper order exists for this clientOrderId.',
      );
    const ack = this.database
      .prepare(
        'SELECT id, status FROM paper_cancel_acknowledgements WHERE client_order_id = ? ORDER BY acknowledged_at_utc DESC LIMIT 1',
      )
      .get(clientOrderId) as { id: string; status: string } | undefined;
    const result = mapPaperCancelAcknowledgement({ status: ack?.status });
    return { ok: true, data: result, evidenceId: cancel.acknowledgementId };
  }

  getOrderByClientId(clientOrderId: string): PaperOrder | null {
    return this.findByClientId(clientOrderId);
  }

  countOrdersForPlan(planId: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM paper_orders WHERE plan_id = ?')
      .get(planId) as { count: number };
    return row.count;
  }

  getAttemptForPlan(planId: string): OrderAttempt | null {
    const row = this.database
      .prepare('SELECT * FROM paper_attempts WHERE plan_id = ?')
      .get(planId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapSqlitePaperOrderAttempt({
      id: row.id,
      planId: row.plan_id,
      operationId: row.operation_id,
      clientOrderId: row.client_order_id,
      requestDigest: row.request_digest,
      state: row.state,
      ...(row.venue_status === null ? {} : { venueStatus: row.venue_status }),
      evidenceSource: row.evidence_source,
      createdAtUtc: row.created_at_utc,
      ...(row.order_id === null ? {} : { orderId: row.order_id }),
      ...(row.reconciled_at_utc === null
        ? {}
        : { reconciledAtUtc: row.reconciled_at_utc }),
    });
  }

  async loadVerificationEvidence(
    planId: string,
  ): Promise<VerificationEvidenceSnapshot> {
    const [plan, authorization] = await Promise.all([
      this.plans.loadPlanEvidence?.(planId),
      this.plans.loadAuthorizationEvidence?.(planId),
    ]);
    const attempt = this.getAttemptForPlan(planId);
    const orderRow = this.database
      .prepare('SELECT * FROM paper_orders WHERE plan_id = ?')
      .get(planId) as Record<string, unknown> | undefined;
    const order = orderRow
      ? persistentPaperOrderSchema.parse(asPaperOrder(orderRow))
      : undefined;
    return {
      ...(plan === undefined ? {} : { plan }),
      ...(authorization === undefined ? {} : { authorization }),
      ...(attempt === null
        ? {}
        : { attempts: { evidenceId: attempt.id, data: [attempt] } }),
      ...(order === undefined
        ? {}
        : { order: { evidenceId: order.orderId, data: order } }),
    };
  }

  close(): void {
    this.database.close();
  }

  private migrateExistingSchema(): void {
    const orderColumns = this.database
      .prepare('PRAGMA table_info(paper_orders)')
      .all() as Array<{ name: string }>;
    if (!orderColumns.some((column) => column.name === 'filled_quantity')) {
      this.database.exec(
        "ALTER TABLE paper_orders ADD COLUMN filled_quantity TEXT NOT NULL DEFAULT '0'",
      );
    }

    const attemptDefinition = this.database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paper_attempts'",
      )
      .get() as { sql: string } | undefined;
    if (!attemptDefinition?.sql.includes("state = 'ACKNOWLEDGED'")) return;

    this.database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE paper_attempts RENAME TO paper_attempts_legacy;
      CREATE TABLE paper_attempts (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(plan_id),
        operation_id TEXT NOT NULL UNIQUE,
        client_order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(client_order_id),
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PREPARED', 'SENDING', 'UNCERTAIN', 'ACKNOWLEDGED', 'RECONCILED')),
        venue_status TEXT CHECK (venue_status IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')),
        evidence_source TEXT NOT NULL CHECK (evidence_source = 'ORIGINAL_PAPER'),
        created_at_utc TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(order_id),
        reconciled_at_utc TEXT
      ) STRICT;
      INSERT INTO paper_attempts (
        id, plan_id, operation_id, client_order_id, request_digest, state,
        venue_status, evidence_source, created_at_utc, order_id
      ) SELECT id, plan_id, operation_id, client_order_id, request_digest, state,
        venue_status, evidence_source, created_at_utc, order_id
        FROM paper_attempts_legacy;
      DROP TABLE paper_attempts_legacy;
      COMMIT;
    `);
  }

  private findByClientId(clientOrderId: string): PaperOrder | null {
    const row = this.database
      .prepare('SELECT * FROM paper_orders WHERE client_order_id = ?')
      .get(clientOrderId) as Record<string, unknown> | undefined;
    return row ? asPaperOrder(row) : null;
  }

  private validate(
    request: PaperOrderRequest,
    plan: ApprovedPaperPlan,
  ): PaperResult<never> | null {
    if (
      !request.clientOrderId ||
      request.symbol !== 'BTCUSDT' ||
      request.planId !== plan.id ||
      request.side !== plan.side ||
      plan.symbol !== 'BTCUSDT' ||
      plan.mode !== 'PAPER' ||
      plan.state !== 'SUBMITTING' ||
      !plan.approvedAtUtc ||
      !isUtcTimestamp(plan.approvedAtUtc) ||
      !isUtcTimestamp(plan.expiresAtUtc) ||
      !plan.planHash
    ) {
      return error('REJECTED', 'Order does not match an approved PAPER plan.');
    }
    const expiresAt = Date.parse(plan.expiresAtUtc);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      return error('EXPIRED', 'The approved plan has expired.');
    }

    try {
      const quantity = parsePositiveDecimal(request.quantity, 'quantity');
      const requestedPrice = parsePositiveDecimal(
        request.limitPrice,
        'limitPrice',
      );
      const approvedPrice = parsePositiveDecimal(
        plan.limitPrice,
        'approved limitPrice',
      );
      if (
        request.side === 'BUY' &&
        compareDecimal(requestedPrice, approvedPrice) > 0
      ) {
        return error(
          'REJECTED',
          'BUY limitPrice exceeds the approved maximum.',
        );
      }
      if (
        request.side === 'SELL' &&
        compareDecimal(requestedPrice, approvedPrice) < 0
      ) {
        return error(
          'REJECTED',
          'SELL limitPrice is below the approved minimum.',
        );
      }
      if (request.side === 'BUY') {
        if (plan.baseQuantityBtc && plan.quoteBudgetUsdt) {
          return error(
            'REJECTED',
            'Plan has conflicting BUY quantity and budget constraints.',
          );
        }
        if (plan.baseQuantityBtc) {
          if (
            compareDecimal(
              quantity,
              parsePositiveDecimal(plan.baseQuantityBtc, 'approved quantity'),
            ) !== 0
          ) {
            return error(
              'REJECTED',
              'Order quantity differs from the approved quantity.',
            );
          }
        } else if (plan.quoteBudgetUsdt) {
          const budget = parsePositiveDecimal(
            plan.quoteBudgetUsdt,
            'approved quote budget',
          );
          if (
            compareDecimal(multiplyDecimal(quantity, requestedPrice), budget) >
            0
          ) {
            return error(
              'REJECTED',
              'Order notional exceeds the approved quote budget.',
            );
          }
        } else {
          return error(
            'REJECTED',
            'BUY plan lacks an approved quantity or quote budget.',
          );
        }
      } else if (
        !plan.baseQuantityBtc ||
        compareDecimal(
          quantity,
          parsePositiveDecimal(plan.baseQuantityBtc, 'approved quantity'),
        ) !== 0
      ) {
        return error(
          'REJECTED',
          'SELL quantity differs from the approved BTC quantity.',
        );
      }
    } catch (cause) {
      return error(
        'REJECTED',
        cause instanceof Error ? cause.message : 'Invalid decimal input.',
      );
    }
    return null;
  }
}
