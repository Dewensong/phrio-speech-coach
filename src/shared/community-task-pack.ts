import { z } from 'zod';

import { IdentifierSchema, ModeIdSchema, VersionSchema } from './domain';

const CommunityTaskSchema = z
  .object({
    id: IdentifierSchema,
    modeId: ModeIdSchema,
    title: z.string().min(1).max(180),
    prompt: z.string().min(1).max(1_000),
    description: z.string().min(1).max(1_000),
    durationSeconds: z.number().int().min(30).max(300),
    audience: z.string().min(1).max(300),
    objective: z.string().min(1).max(500),
    scenario: z.string().min(1).max(300),
    background: z.string().max(2_000).optional(),
    sourceMaterial: z.string().max(5_000).optional(),
    counterArgument: z.string().max(2_000).optional(),
    constraints: z.array(z.string().min(1).max(500)).max(12),
    successConditions: z.array(z.string().min(1).max(500)).min(1).max(12),
    requiredFields: z.array(IdentifierSchema).max(16),
    focusCriteria: z.array(IdentifierSchema).min(1).max(16),
  })
  .strict();

export const CommunityTaskPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    version: VersionSchema,
    language: z.literal('zh-CN'),
    license: z.literal('MIT'),
    author: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    tasks: z.array(CommunityTaskSchema).min(1).max(100),
  })
  .strict()
  .superRefine((pack, context) => {
    const ids = pack.tasks.map((task) => task.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'community task ids must be unique inside one pack',
      });
    }
  });

export type CommunityTaskPack = z.infer<typeof CommunityTaskPackSchema>;

const modules = import.meta.glob<{ default: unknown }>(
  '../../task-packs/contributions/*.json',
  { eager: true },
);

export function validateCommunityTaskPackCollection(
  packs: readonly CommunityTaskPack[],
): readonly CommunityTaskPack[] {
  const packIds = packs.map((pack) => pack.id);
  if (new Set(packIds).size !== packIds.length) {
    throw new Error('INVALID_COMMUNITY_TASK_PACK_COLLECTION:pack ids must be unique');
  }
  return Object.freeze([...packs]);
}

export const COMMUNITY_TASK_PACKS: readonly CommunityTaskPack[] =
  validateCommunityTaskPackCollection(
    Object.entries(modules)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, module]) => {
        const parsed = CommunityTaskPackSchema.safeParse(module.default);
        if (!parsed.success) {
          throw new Error(
            `INVALID_COMMUNITY_TASK_PACK:${source}:${parsed.error.issues
              .map((issue) => `${issue.path.join('.')}:${issue.message}`)
              .join('|')}`,
          );
        }
        return parsed.data;
      }),
  );
