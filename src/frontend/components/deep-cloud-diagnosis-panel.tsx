import { useEffect, useRef } from 'react';
import { BrainCircuit, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';

import type { DeepCloudDiagnosisController } from '../hooks/use-deep-cloud-diagnosis';
import { DeepCloudDiagnosisRun } from './deep-cloud-diagnosis-run';

interface DeepCloudDiagnosisPanelProps {
  readonly controller: DeepCloudDiagnosisController;
  readonly onAdoptFocus: (criterionId: string, drillId: string, analysisInputId: string) => void;
  readonly onLocateSegment: (segmentId: string) => void;
}

export function DeepCloudDiagnosisPanel({
  controller,
  onAdoptFocus,
  onLocateSegment,
}: DeepCloudDiagnosisPanelProps) {
  const busy = controller.operation !== null;
  const payloadEditor = useRef<HTMLTextAreaElement>(null);
  const editorTrigger = useRef<HTMLButtonElement>(null);
  const editorReturnFocus = useRef<'primary-trigger' | HTMLElement | null>(null);
  const editorWasOpen = useRef(controller.editorOpen);

  useEffect(() => {
    const wasOpen = editorWasOpen.current;
    editorWasOpen.current = controller.editorOpen;
    if (controller.editorOpen && !wasOpen) {
      payloadEditor.current?.focus({ preventScroll: true });
    } else if (!controller.editorOpen && wasOpen) {
      const returnTarget = editorReturnFocus.current;
      editorReturnFocus.current = null;
      if (returnTarget === 'primary-trigger') {
        editorTrigger.current?.focus({ preventScroll: true });
      } else if (returnTarget?.isConnected) {
        returnTarget.focus({ preventScroll: true });
      }
    }
  }, [controller.editorOpen]);
  return (
    <section className="deep-cloud-panel" aria-label="完整 AI 复盘">
      <header>
        <BrainCircuit aria-hidden="true" size={16} />
        <div>
          <strong>完整 AI 复盘 · 独立可选</strong>
          <span>本地复盘已可用；音频、partial 和实时短提示不会作为最终诊断输入。</span>
        </div>
      </header>
      <p className="deep-cloud-availability" data-status={controller.availability}>{controller.availabilityMessage}</p>

      {controller.revisionNotice ? <p className="deep-cloud-notice" role="status">{controller.revisionNotice}</p> : null}
      {controller.persistenceError ? <p className="inline-error" role="alert">{controller.persistenceError}</p> : null}
      {controller.validationError ? <p className="inline-error" role="alert">{controller.validationError}</p> : null}

      {controller.availability === 'ready' && !controller.editorOpen ? (
        <button
          className="secondary-button"
          onClick={() => {
            editorReturnFocus.current = 'primary-trigger';
            controller.openEditor();
          }}
          ref={editorTrigger}
          type="button"
        >
          <ShieldCheck aria-hidden="true" size={14} />预览并删减发送内容
        </button>
      ) : null}
      {controller.availability === 'error' || controller.availability === 'unconfigured' ? (
        <button className="text-button" onClick={controller.refresh} type="button">
          <RefreshCw aria-hidden="true" size={13} />重新检查配置
        </button>
      ) : null}

      {controller.editorOpen ? (
        <section className="deep-cloud-payload-editor" aria-label="deep_diagnosis payload 预览">
          <header>
            <div><strong>本次 exact payload</strong><span>可编辑文本、删除数组条目；身份字段和句段锚点不可改。</span></div>
            <button aria-label="关闭 payload 预览" className="icon-button" disabled={busy} onClick={controller.closeEditor} type="button"><X aria-hidden="true" size={14} /></button>
          </header>
          <textarea
            aria-label="可编辑的 deep_diagnosis JSON"
            disabled={busy}
            onChange={(event) => controller.changePayloadJson(event.target.value)}
            ref={payloadEditor}
            spellCheck={false}
            value={controller.payloadJson}
          />
          <p>只有此处最终校验通过的 JSON 会进入批准流程；每次纠正或重试都会生成新的 payload 身份。</p>
          {controller.prepared ? (
            <div className="deep-cloud-approval-summary">
              <dl>
                <div><dt>用途</dt><dd>deep_diagnosis</dd></div>
                <div><dt>Payload hash</dt><dd><code>{controller.prepared.payloadHash}</code></dd></div>
                <div><dt>字段</dt><dd>{controller.prepared.approvedFields.join('、')}</dd></div>
              </dl>
              <details>
                <summary>查看后台规范化的批准内容</summary>
                <pre>{controller.prepared.previewJson}</pre>
              </details>
              <p>{controller.prepared.retentionNotice}</p>
            </div>
          ) : null}
          <div className="page-actions">
            {controller.prepared ? (
              <button className="primary-button" disabled={busy} onClick={() => void controller.approveAndExecute()} type="button">
                <Send aria-hidden="true" size={14} />{controller.operation === 'approving' ? '正在批准…' : '逐 payload 批准并发送'}
              </button>
            ) : (
              <button className="primary-button" disabled={busy || !controller.payloadJson.trim()} onClick={() => void controller.prepare()} type="button">
                <ShieldCheck aria-hidden="true" size={14} />{controller.operation === 'preparing' ? '正在校验…' : '校验并生成批准摘要'}
              </button>
            )}
            <button className="secondary-button" disabled={busy} onClick={controller.closeEditor} type="button">取消</button>
          </div>
        </section>
      ) : null}

      {controller.runs.length ? (
        <section className="deep-cloud-runs" aria-label="完整 AI 复盘历史">
          <h3>本轮云端复盘记录</h3>
          {controller.runs.map((run) => (
            <DeepCloudDiagnosisRun
              key={run.analysisInputId}
              canResume={controller.availability === 'ready'}
              isResuming={controller.activeRunIds.includes(run.analysisInputId)}
              onAdoptFocus={onAdoptFocus}
              onLocateSegment={onLocateSegment}
              onResume={() => controller.resume(run)}
              onRetry={(trigger) => {
                editorReturnFocus.current = trigger;
                controller.retry();
              }}
              run={run}
            />
          ))}
        </section>
      ) : null}
    </section>
  );
}
