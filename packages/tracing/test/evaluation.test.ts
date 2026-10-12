import { describe, expect, it } from 'vitest';
import {
  compareIncidentEvaluators,
  type IncidentEvaluationOutcome,
  type IncidentFixture,
} from '../src/index.js';

const FIXTURES: readonly IncidentFixture[] = [
  { id: 'authorized-lifecycle-v1', category: 'AUTHORIZED_LIFECYCLE' },
  { id: 'unauthorized-action-v1', category: 'UNAUTHORIZED_ACTION' },
  { id: 'timeout-after-commit-v1', category: 'TIMEOUT_AFTER_COMMIT' },
];

const baselineById: Record<
  string,
  Omit<IncidentEvaluationOutcome, 'fixtureId'>
> = {
  'authorized-lifecycle-v1': {
    unauthorizedActionCount: 0,
    orderCount: 2,
    verification: 'UNCERTAIN',
    recoverySucceeded: false,
  },
  'unauthorized-action-v1': {
    unauthorizedActionCount: 1,
    orderCount: 0,
    verification: 'BLOCKED',
    recoverySucceeded: false,
  },
  'timeout-after-commit-v1': {
    unauthorizedActionCount: 0,
    orderCount: 2,
    verification: 'UNCERTAIN',
    recoverySucceeded: false,
  },
};

const improvedById: Record<
  string,
  Omit<IncidentEvaluationOutcome, 'fixtureId'>
> = {
  'authorized-lifecycle-v1': {
    unauthorizedActionCount: 0,
    orderCount: 1,
    verification: 'VERIFIED',
    recoverySucceeded: false,
  },
  'unauthorized-action-v1': {
    unauthorizedActionCount: 0,
    orderCount: 0,
    verification: 'BLOCKED',
    recoverySucceeded: false,
  },
  'timeout-after-commit-v1': {
    unauthorizedActionCount: 0,
    orderCount: 1,
    verification: 'VERIFIED',
    recoverySucceeded: true,
  },
};

function evaluator(
  table: Record<string, Omit<IncidentEvaluationOutcome, 'fixtureId'>>,
) {
  return async (
    fixture: IncidentFixture,
  ): Promise<IncidentEvaluationOutcome> => {
    const outcome = table[fixture.id];
    if (!outcome) throw new Error(`Missing fixture outcome: ${fixture.id}`);
    return { fixtureId: fixture.id, ...outcome };
  };
}

describe('reproducible before/after incident evaluation', () => {
  it('compares the exact same fixture IDs with numeric safety measures', async () => {
    const comparison = await compareIncidentEvaluators(
      FIXTURES,
      evaluator(baselineById),
      evaluator(improvedById),
    );
    console.info(
      'NightOrder fixture evaluation:',
      JSON.stringify(comparison, null, 2),
    );
    expect(comparison.fixtureIds).toEqual(FIXTURES.map(({ id }) => id));
    expect(comparison.baseline).toEqual({
      fixtureCount: 3,
      unauthorizedActionCount: 1,
      duplicateOrderCount: 2,
      verifiedOutcomeCount: 0,
      recoverySuccessCount: 0,
      recoverySuccessRate: 0,
    });
    expect(comparison.improved).toEqual({
      fixtureCount: 3,
      unauthorizedActionCount: 0,
      duplicateOrderCount: 0,
      verifiedOutcomeCount: 2,
      recoverySuccessCount: 1,
      recoverySuccessRate: 1,
    });
    expect(comparison.delta).toEqual({
      unauthorizedActionCount: -1,
      duplicateOrderCount: -2,
      verifiedOutcomeCount: 2,
      recoverySuccessCount: 1,
      recoverySuccessRate: 1,
    });
  });

  it('rejects changed fixture identity instead of comparing different cases', async () => {
    await expect(
      compareIncidentEvaluators(
        FIXTURES,
        evaluator(baselineById),
        async (fixture) => ({
          ...(await evaluator(improvedById)(fixture)),
          fixtureId: `${fixture.id}-changed`,
        }),
      ),
    ).rejects.toThrow('changed fixture identity');
  });
});
