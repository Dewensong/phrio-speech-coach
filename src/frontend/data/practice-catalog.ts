import { P1_MODE_PACKS } from '../../shared';
import type { PracticeTask } from '../types/ui';

const DEFAULT_TASK_ID = 'freeze-new-requirements';

function taskView(
  task: (typeof P1_MODE_PACKS)[number]['tasks'][number],
): PracticeTask {
  const mode = P1_MODE_PACKS.find((pack) => pack.id === task.modeId);
  if (!mode) throw new Error(`MODE_PACK_NOT_FOUND:${task.modeId}`);
  return {
    id: task.id,
    developmentFixture: task.developmentFixture,
    title: task.prompt,
    hint: task.description,
    mode: task.modeId,
    modeLabel: mode.name,
    durationSeconds: task.recommendedDurationSeconds,
    audience: task.context.audience,
    goal: task.context.objective,
    successConditions: task.successConditions,
  };
}

export const PRACTICE_TASKS: readonly PracticeTask[] = P1_MODE_PACKS.flatMap(
  (mode) => mode.tasks.map(taskView),
);

const defaultTask = P1_MODE_PACKS.flatMap((mode) => mode.tasks).find(
  (task) => task.id === DEFAULT_TASK_ID,
);
if (!defaultTask) throw new Error(`DEFAULT_TASK_NOT_FOUND:${DEFAULT_TASK_ID}`);

export const CANONICAL_TASK: PracticeTask = taskView(defaultTask);

export const MODE_OPTIONS = P1_MODE_PACKS.map((mode) => ({
  id: mode.id,
  title: mode.abilityName,
  role: mode.typicalRole,
  description: mode.description,
})) as ReadonlyArray<{
  id: (typeof P1_MODE_PACKS)[number]['id'];
  title: string;
  role: string;
  description: string;
}>;
