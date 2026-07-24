import { describe, expect, it } from 'vitest';

import {
  COMMUNITY_TASK_PACKS,
  CommunityTaskPackSchema,
  getTaskTemplate,
  validateCommunityTaskPackCollection,
} from '../../src/shared';

describe('community task packs', () => {
  it('loads repository contributions into the frozen production task registry', () => {
    expect(COMMUNITY_TASK_PACKS).toHaveLength(1);
    const task = getTaskTemplate(
      'decision-alignment',
      'community.product-review.review-update',
    );
    expect(task?.prompt).toContain('上一版到这一版');
    expect(task?.focusCandidateCriterionIds).toEqual([
      'decision-request',
      'tradeoff-priority',
    ]);
  });

  it('requires explicit MIT contribution terms and rejects duplicate task ids', () => {
    const result = CommunityTaskPackSchema.safeParse({
      schemaVersion: 1,
      id: 'invalid-pack',
      version: '1.0.0',
      language: 'zh-CN',
      license: 'proprietary',
      author: 'Example',
      description: 'Invalid fixture',
      tasks: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate pack namespaces before tasks are compiled', () => {
    const pack = COMMUNITY_TASK_PACKS[0]!;
    expect(() => validateCommunityTaskPackCollection([pack, pack]))
      .toThrow('pack ids must be unique');
  });
});
