import {
  cancelRequestResultSchema,
  orderReadbackResultSchema,
  paperCancelAcknowledgementSchema,
  type CancelRequestResult,
  type OrderReadbackResult,
} from './schemas.js';

/**
 * Adapt the synchronous SQLite mutation response to the shared command port.
 * `CANCELED` here acknowledges that the cancel write committed; it is not used
 * as independent evidence that the durable order readback is terminal.
 */
export function mapPaperCancelAcknowledgement(
  input: unknown,
): CancelRequestResult {
  paperCancelAcknowledgementSchema.parse(input);
  return cancelRequestResultSchema.parse({ status: 'CANCEL_REQUESTED' });
}

/** Validate the separate read path which alone can confirm cancellation. */
export function mapPaperOrderReadback(input: unknown): OrderReadbackResult {
  return orderReadbackResultSchema.parse(input);
}
