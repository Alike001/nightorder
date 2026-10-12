export type EvaluationVerification = 'VERIFIED' | 'BLOCKED' | 'UNCERTAIN';

export interface IncidentFixture {
  readonly id: string;
  readonly category:
    'AUTHORIZED_LIFECYCLE' | 'UNAUTHORIZED_ACTION' | 'TIMEOUT_AFTER_COMMIT';
}

export interface IncidentEvaluationOutcome {
  readonly fixtureId: string;
  readonly unauthorizedActionCount: number;
  readonly orderCount: number;
  readonly verification: EvaluationVerification;
  readonly recoverySucceeded: boolean;
}

export interface EvaluationMetrics {
  readonly fixtureCount: number;
  readonly unauthorizedActionCount: number;
  readonly duplicateOrderCount: number;
  readonly verifiedOutcomeCount: number;
  readonly recoverySuccessCount: number;
  readonly recoverySuccessRate: number;
}

export interface EvaluationComparison {
  readonly fixtureIds: readonly string[];
  readonly baseline: EvaluationMetrics;
  readonly improved: EvaluationMetrics;
  readonly delta: Omit<EvaluationMetrics, 'fixtureCount'>;
}

export type IncidentEvaluator = (
  fixture: IncidentFixture,
) => Promise<IncidentEvaluationOutcome>;

function metrics(
  fixtures: readonly IncidentFixture[],
  outcomes: readonly IncidentEvaluationOutcome[],
): EvaluationMetrics {
  const recoveryFixtures = fixtures.filter(
    (fixture) => fixture.category === 'TIMEOUT_AFTER_COMMIT',
  ).length;
  const recoverySuccessCount = outcomes.filter(
    (outcome, index) =>
      fixtures[index]?.category === 'TIMEOUT_AFTER_COMMIT' &&
      outcome.recoverySucceeded,
  ).length;
  return {
    fixtureCount: fixtures.length,
    unauthorizedActionCount: outcomes.reduce(
      (sum, outcome) => sum + outcome.unauthorizedActionCount,
      0,
    ),
    duplicateOrderCount: outcomes.reduce(
      (sum, outcome) => sum + Math.max(0, outcome.orderCount - 1),
      0,
    ),
    verifiedOutcomeCount: outcomes.filter(
      (outcome) => outcome.verification === 'VERIFIED',
    ).length,
    recoverySuccessCount,
    recoverySuccessRate:
      recoveryFixtures === 0 ? 0 : recoverySuccessCount / recoveryFixtures,
  };
}

function subtract(
  after: EvaluationMetrics,
  before: EvaluationMetrics,
): Omit<EvaluationMetrics, 'fixtureCount'> {
  return {
    unauthorizedActionCount:
      after.unauthorizedActionCount - before.unauthorizedActionCount,
    duplicateOrderCount: after.duplicateOrderCount - before.duplicateOrderCount,
    verifiedOutcomeCount:
      after.verifiedOutcomeCount - before.verifiedOutcomeCount,
    recoverySuccessCount:
      after.recoverySuccessCount - before.recoverySuccessCount,
    recoverySuccessRate: after.recoverySuccessRate - before.recoverySuccessRate,
  };
}

export async function compareIncidentEvaluators(
  fixtures: readonly IncidentFixture[],
  baseline: IncidentEvaluator,
  improved: IncidentEvaluator,
): Promise<EvaluationComparison> {
  const ids = fixtures.map((fixture) => fixture.id);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(
      'Evaluation fixtures must have unique IDs and not be empty',
    );
  }
  const [baselineOutcomes, improvedOutcomes] = await Promise.all([
    Promise.all(fixtures.map(baseline)),
    Promise.all(fixtures.map(improved)),
  ]);
  for (const outcomes of [baselineOutcomes, improvedOutcomes]) {
    outcomes.forEach((outcome, index) => {
      if (outcome.fixtureId !== ids[index]) {
        throw new Error('Evaluator changed fixture identity or ordering');
      }
      if (
        !Number.isInteger(outcome.unauthorizedActionCount) ||
        outcome.unauthorizedActionCount < 0 ||
        !Number.isInteger(outcome.orderCount) ||
        outcome.orderCount < 0
      ) {
        throw new Error('Evaluation counts must be non-negative integers');
      }
    });
  }
  const baselineMetrics = metrics(fixtures, baselineOutcomes);
  const improvedMetrics = metrics(fixtures, improvedOutcomes);
  return {
    fixtureIds: ids,
    baseline: baselineMetrics,
    improved: improvedMetrics,
    delta: subtract(improvedMetrics, baselineMetrics),
  };
}
