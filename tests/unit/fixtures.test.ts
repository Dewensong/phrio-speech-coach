import { describe, expect, it } from 'vitest';

import {
  COMMUNITY_TASK_PACKS,
  GATE_C_PM_FIXTURE,
  GATE_C_PM_TASK,
  GateCFixtureSchema,
  P1_MODE_PACKS,
} from '../../src/shared';

function count(text: string, token: string): number {
  return text.split(token).length - 1;
}

describe('Gate C development fixture', () => {
  it('keeps the synthetic Gate C evidence isolated from production Mode Packs', () => {
    expect(GATE_C_PM_FIXTURE.developmentFixture).toBe(true);
    expect(GATE_C_PM_FIXTURE.disclaimer).toContain('开发演示数据');
    expect(GATE_C_PM_TASK.developmentFixture).toBe(false);
    expect(P1_MODE_PACKS.every((pack) => !pack.developmentFixture)).toBe(true);
    for (const pack of P1_MODE_PACKS) {
      const contributedCount = COMMUNITY_TASK_PACKS.flatMap((communityPack) => (
        communityPack.tasks.filter((task) => task.modeId === pack.id)
      )).length;
      expect(pack.tasks).toHaveLength(8 + contributedCount);
      expect(pack.tasks.every((task) => !task.developmentFixture)).toBe(true);
      expect(pack.criteria.length).toBeGreaterThanOrEqual(5);
      expect(pack.criteria.length).toBeLessThanOrEqual(7);
      for (const criterion of pack.criteria) {
        expect(
          pack.drills.filter((drill) => drill.criterionId === criterion.id).length,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('matches the canonical PM mode, task, attempt durations and focus', () => {
    expect(GateCFixtureSchema.parse(GATE_C_PM_FIXTURE)).toEqual(GATE_C_PM_FIXTURE);
    expect(GATE_C_PM_FIXTURE.modeId).toBe('decision-alignment');
    expect(GATE_C_PM_FIXTURE.taskId).toBe('freeze-new-requirements');
    expect(GATE_C_PM_FIXTURE.firstAttempt.durationMs).toBe(74_000);
    expect(GATE_C_PM_FIXTURE.secondAttempt.durationMs).toBe(42_000);
    expect(GATE_C_PM_FIXTURE.focus.criterionId).toBe('conclusion-first');
    expect(GATE_C_PM_FIXTURE.focus.drillId).toBe('decision-first-three-lines');
  });

  it('preserves the E01-E03 evidence anchors and comparison values', () => {
    expect(GATE_C_PM_FIXTURE.evidence.map((item) => item.displayId)).toEqual([
      'E01',
      'E02',
      'E03',
    ]);

    const metrics = Object.fromEntries(
      GATE_C_PM_FIXTURE.comparison.metrics.map((metric) => [metric.id, metric]),
    );
    expect(metrics['conclusion-appearance']).toMatchObject({
      initial: 24_000,
      retry: 3_000,
    });
    expect(metrics['filler-count']).toMatchObject({ initial: 11, retry: 2 });
    expect(metrics['explicit-action-count']).toMatchObject({ initial: 0, retry: 1 });
    expect(metrics.duration).toMatchObject({ initial: 74_000, retry: 42_000 });
  });

  it('keeps the documented filler-expression count internally consistent', () => {
    const initial = GATE_C_PM_FIXTURE.firstAttempt.segments
      .map((segment) => segment.text)
      .join('');
    const retry = GATE_C_PM_FIXTURE.secondAttempt.segments
      .map((segment) => segment.text)
      .join('');

    const initialCount =
      count(initial, '嗯') +
      count(initial, '然后') +
      count(initial, '其实') +
      count(initial, '就是') +
      count(initial, '所以说');
    const retryCount = count(retry, '嗯') + count(retry, '然后');

    expect(initialCount).toBe(11);
    expect(retryCount).toBe(2);
  });

  it('rejects a fixture whose development marker is removed', () => {
    expect(
      GateCFixtureSchema.safeParse({
        ...GATE_C_PM_FIXTURE,
        developmentFixture: false,
      }).success,
    ).toBe(false);
  });
});
