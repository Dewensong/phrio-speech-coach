import { Clock3, LocateFixed, Play, RotateCcw } from 'lucide-react';

import type { CloudDeepDiagnosisArtifact } from '../../shared';

const STATUS_LABELS: Record<CloudDeepDiagnosisArtifact['status'], string> = {
  queued: '已排队',
  processing: '处理中',
  complete: '已完成',
  failed: '失败',
  superseded: '历史态 · 已被纠正版本替代',
};

interface DeepCloudDiagnosisRunProps {
  readonly run: CloudDeepDiagnosisArtifact;
  readonly onAdoptFocus: (criterionId: string, drillId: string, analysisInputId: string) => void;
  readonly onLocateSegment: (segmentId: string) => void;
  readonly onResume: () => void;
  readonly canResume: boolean;
  readonly isResuming: boolean;
  readonly onRetry: (trigger: HTMLButtonElement) => void;
}

export function DeepCloudDiagnosisRun({
  run,
  onAdoptFocus,
  onLocateSegment,
  onResume,
  canResume,
  isResuming,
  onRetry,
}: DeepCloudDiagnosisRunProps) {
  const result = run.result;
  const focusCriterion = result
    ? run.approvedPayload.task.rubric.find(
        (criterion) => criterion.criterionId === result.focus.criterionId,
      )
    : null;
  const focusDrill = result
    ? run.approvedPayload.task.drills.find((drill) => drill.drillId === result.focus.drillId)
    : null;

  return (
    <article className="deep-cloud-run" data-status={run.status}>
      <header>
        <strong>{STATUS_LABELS[run.status]}</strong>
        <span><Clock3 aria-hidden="true" size={12} />{new Date(run.updatedAt).toLocaleString('zh-CN')}</span>
      </header>
      <ol className="deep-cloud-lifecycle" aria-label="AI 复盘处理历史">
        {run.lifecycle.map((event, index) => (
          <li key={`${event.status}-${event.at}-${index}`}>
            <span>{STATUS_LABELS[event.status]}</span>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('zh-CN')}</time>
            {event.errorCode ? <code>{event.errorCode}</code> : null}
          </li>
        ))}
      </ol>
      {run.status === 'queued' || run.status === 'processing' ? (
        <div className="deep-cloud-run-recovery">
          <p role="status">{isResuming
            ? '已批准 payload 正在处理，冻结快照和本地 Drill 不受阻塞。'
            : canResume
              ? '上次处理未留下终态；可继续发送同一份已批准 payload，不会新增字段或扩大用途。'
              : '已批准 payload 等待继续；请先恢复云端配置，冻结快照和本地 Drill 不受影响。'}</p>
          <button className="text-button" disabled={isResuming || !canResume} onClick={onResume} type="button">
            <Play aria-hidden="true" size={13} />{isResuming ? '正在处理已批准 payload…' : '继续处理已批准 payload'}
          </button>
        </div>
      ) : null}
      {run.status === 'failed' ? (
        <div className="deep-cloud-run-error">
          <p role="alert">本次云端复盘失败：<code>{run.errorCode}</code></p>
          <button className="text-button" onClick={(event) => onRetry(event.currentTarget)} type="button">
            <RotateCcw aria-hidden="true" size={13} />重新预览并批准
          </button>
        </div>
      ) : null}
      {run.status === 'superseded' ? (
        <p className="deep-cloud-history-note">逐字稿纠正改变了获批 payload；此结果只保留为中性历史，不再作为当前诊断。</p>
      ) : null}
      {result ? (
        <div className="deep-cloud-result">
          <p className="eyebrow">完整 AI 复盘 · 不是实时短提示</p>
          <p>{result.judgment}</p>
          <div className="deep-cloud-observations">
            {result.observations.map((observation, index) => {
              const segment = observation.segmentId
                ? run.approvedPayload.finalSegments.find(
                    (candidate) => candidate.id === observation.segmentId,
                  )
                : null;
              const criterion = run.approvedPayload.task.rubric.find(
                (candidate) => candidate.criterionId === observation.criterionId,
              );
              return (
                <article key={`${observation.type}-${observation.criterionId}-${observation.segmentId ?? index}`}>
                  <header><strong>{criterion?.label ?? observation.criterionId}</strong><span>{observation.confidence} confidence</span></header>
                  <p>{observation.evidence}</p>
                  <small>{observation.suggestion}</small>
                  {segment ? (
                    <div className="deep-cloud-source-reference">
                      <blockquote>{segment.text}</blockquote>
                      <button className="text-button" onClick={() => onLocateSegment(segment.id)} type="button">
                        <LocateFixed aria-hidden="true" size={12} />定位 final 句段
                      </button>
                    </div>
                  ) : observation.type === 'deterministic_metric' ? (
                    <code className="deep-cloud-metric-reference">获批本地指标：{JSON.stringify(run.approvedPayload.metrics)}</code>
                  ) : (
                    <p className="deep-cloud-task-reference">Rubric 依据：{criterion?.description ?? '当前任务要求'}</p>
                  )}
                </article>
              );
            })}
          </div>
          {focusCriterion && focusDrill ? (
            <section className="deep-cloud-focus">
              <span>AI 建议的唯一焦点 · 仅来自获批 Rubric/Drill</span>
              <strong>{focusCriterion.label}</strong>
              <p>{result.focus.reason}</p>
              <small>{focusDrill.title}：{focusDrill.template}</small>
              <button
                className="secondary-button"
                disabled={run.status === 'superseded'}
                onClick={() => onAdoptFocus(
                  focusCriterion.criterionId,
                  focusDrill.drillId,
                  run.analysisInputId,
                )}
                type="button"
              >明确采用这个焦点</button>
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
