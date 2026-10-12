import { createHash } from 'node:crypto';

export const immutableInstructionKeys = [
  'id',
  'ownerId',
  'symbol',
  'side',
  'quoteBudgetUsdt',
  'baseQuantityBtc',
  'triggerPrice',
  'triggerOperator',
  'limitPrice',
  'expiresAtUtc',
  'timezone',
  'mode',
] as const;

export type CanonicalInstructionInput = Partial<
  Record<(typeof immutableInstructionKeys)[number], unknown>
>;

export function canonicalizeInstructionFields(
  instruction: CanonicalInstructionInput,
): string {
  const canonical: Record<string, unknown> = {};
  for (const key of immutableInstructionKeys) {
    const value = instruction[key];
    if (value !== undefined) canonical[key] = value;
  }
  return JSON.stringify(canonical);
}

export function digestInstructionFields(
  instruction: CanonicalInstructionInput,
): string {
  return createHash('sha256')
    .update(canonicalizeInstructionFields(instruction), 'utf8')
    .digest('hex');
}
