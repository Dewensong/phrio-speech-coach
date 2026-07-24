import {
  ArrowDownToLine,
  CheckCircle2,
  Crosshair,
  Quote,
  ShieldCheck,
} from 'lucide-react';
import { useId, type Ref } from 'react';

import type {
  AttemptSnapshot,
  DeepEvidenceView,
  DeepReport,
} from '../../shared';

const EVIDENCE_LABELS: Record<DeepEvidenceView['annotation']['type'], string> = {
  filler: '填充表达',
  hedge: '弱化表达',
  vague: '模糊表达',
  repetition: '重复',
  self_correction: '自我修正',
  long_pause: '停顿',
  speech_rate: '语速',
  structure: '结构',
  task_gap: '任务缺口',
};

export interface DiagnosisFocusSummary {
  readonly criterionLabel: string;
  readonly successCondition: string;
  readonly drillTitle?: string;
  readonly drillTemplate?: string;
}

interface DiagnosisResultCardProps {
  readonly report: DeepReport;
  readonly evidence: readonly DeepEvidenceView[];
  readonly snapshot: AttemptSnapshot;
  readonly suggestedFocus: DiagnosisFocusSummary;
  readonly suggestionSource: string;
  readonly onLocateEvidence: (segmentId: string, evidenceId: string) => void;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly headingLevel?: 1 | 2;
}

export function DiagnosisResultCard({
  report,
  evidence,
  snapshot,
  suggestedFocus,
  suggestionSource,
  onLocateEvidence,
  headingRef,
  headingLevel = 1,
}: DiagnosisResultCardProps) {
  const titleId = useId();
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const confirmedEvidence = evidence.filter((item) => item.currentLifecycle === 'confirmed');
  const primaryEvidence = confirmedEvidence[0] ?? null;
  const recommendations = [...new Set(
    confirmedEvidence
      .map((item) => item.annotation.suggestion.trim())
      .filter(Boolean),
  )].slice(0, 3);
  if (recommendations.length === 0) {
    recommendations.push(
      `围绕“${suggestedFocus.criterionLabel}”重说一遍，再用上方成功标准自查。`,
    );
  }

  return (
    <article className="diagnosis-result-card" aria-labelledby={titleId}>
      <header>
        <div>
          <p className="eyebrow"><CheckCircle2 aria-hidden="true" size={13} />本次诊断结果</p>
          <Heading id={titleId} ref={headingRef} tabIndex={-1}>本轮最需要先处理的一件事</Heading>
          <p>先看结论，再沿着原句证据、唯一焦点和下一步往下读。</p>
        </div>
        <span><ShieldCheck aria-hidden="true" size={13} />本地确定性复盘</span>
      </header>

      <section className="diagnosis-result-conclusion">
        <span>一句话结论</span>
        <p>{report.judgment}</p>
      </section>

      <div className="diagnosis-result-body">
        <section className="diagnosis-key-evidence">
          <header>
            <b>01</b>
            <span><Quote aria-hidden="true" size={13} />为什么这样判断</span>
          </header>
          {primaryEvidence ? (
            <button
              onClick={() => onLocateEvidence(
                primaryEvidence.annotation.segmentId,
                primaryEvidence.annotation.id,
              )}
              type="button"
            >
              <b>{primaryEvidence.annotation.displayId}</b>
              <span>{EVIDENCE_LABELS[primaryEvidence.annotation.type]}</span>
              <span className="diagnosis-evidence-quote">{primaryEvidence.annotation.evidence}</span>
              <small><Crosshair aria-hidden="true" size={12} />定位冻结原句</small>
            </button>
          ) : (
            <div className="diagnosis-evidence-empty">
              <b>本地未发现需要正式标注的问题</b>
              <p>这不等于已经达到任务目标；仍建议用当前 Rubric 自查表达是否完整。</p>
            </div>
          )}
        </section>

        <section className="diagnosis-focus-plan">
          <header>
            <b>02</b>
            <span>只练一个焦点</span>
          </header>
          <h3>{suggestedFocus.criterionLabel}</h3>
          <p>
            {suggestedFocus.drillTitle ? `${suggestedFocus.drillTitle} · ` : ''}
            成功标准：{suggestedFocus.successCondition}
          </p>
          {suggestedFocus.drillTemplate ? (
            <div className="diagnosis-focus-drill">
              <span>内联短 Drill</span>
              <p>{suggestedFocus.drillTemplate}</p>
            </div>
          ) : null}
          <small>{suggestionSource} · 这是诊断建议，不代表已替你选择训练路径</small>
        </section>
      </div>

      <section className="diagnosis-recommendations">
        <header>
          <b>03</b>
          <span><ArrowDownToLine aria-hidden="true" size={13} />下一步怎么改</span>
        </header>
        <ol>
          {recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
        </ol>
      </section>

      <footer>
        <span>诊断依据</span>
        <dl>
          <div><dt>快照</dt><dd>{snapshot.id.slice(0, 12)}…</dd></div>
          <div><dt>逐字稿版本</dt><dd>v{report.transcriptVersion}</dd></div>
          <div><dt>正式证据</dt><dd>{confirmedEvidence.length} 条</dd></div>
        </dl>
      </footer>
    </article>
  );
}
