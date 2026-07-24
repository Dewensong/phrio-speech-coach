import {
  Check,
  Download,
  Expand,
  FileCode2,
  FileText,
  Image,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildShareCardSvg,
  exportShareCard,
  type ShareCardAspect,
  type ShareCardData,
  type ShareCardFormat,
} from '../services/share-card';
import { BrandMark } from './brand-mark';

interface ShareResultDialogProps {
  readonly data: ShareCardData;
  readonly onClose: () => void;
}

const ASPECT_OPTIONS: readonly {
  readonly id: ShareCardAspect;
  readonly label: string;
  readonly detail: string;
}[] = [
  { id: 'landscape', label: '16:10', detail: 'README / 桌面' },
  { id: 'square', label: '1:1', detail: '社交动态' },
  { id: 'portrait', label: '9:16', detail: '竖屏分享' },
];

export function ShareResultDialog({ data, onClose }: ShareResultDialogProps) {
  const [aspect, setAspect] = useState<ShareCardAspect>('landscape');
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [cleanPresentation, setCleanPresentation] = useState(false);
  const [exporting, setExporting] = useState<ShareCardFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const svg = useMemo(
    () => buildShareCardSvg(data, { aspect, includeEvidence }),
    [aspect, data, includeEvidence],
  );
  const svgUrl = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    [svg],
  );

  useEffect(() => {
    if (cleanPresentation) dialogRef.current?.focus();
    else closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (cleanPresentation) {
          setCleanPresentation(false);
          return;
        }
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (cleanPresentation) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [cleanPresentation, onClose]);

  const runExport = async (format: ShareCardFormat) => {
    if (exporting) return;
    setExporting(format);
    setError(null);
    try {
      await exportShareCard(data, { aspect, includeEvidence }, format);
    } catch {
      setError('分享卡没有成功保存。请重试，或先导出 SVG / Markdown。');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div
      aria-label="展示与分享练习结果"
      aria-modal="true"
      className={`share-result-dialog ${cleanPresentation ? 'is-clean-presentation' : ''}`}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="share-dialog-bar">
        <div>
          <BrandMark className="brand-mini-mark" />
          <div><strong>展示与分享</strong><small>本地生成 · 不自动上传</small></div>
        </div>
        <button
          aria-label={cleanPresentation ? '退出纯净展示' : '关闭展示与分享'}
          className="icon-button"
          onClick={() => cleanPresentation ? setCleanPresentation(false) : onClose()}
          ref={closeRef}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      <main className="share-dialog-body">
        <section className={`share-card-stage is-${aspect}`}>
          <img alt="Phrio 练习结果分享卡预览" src={svgUrl} />
          {cleanPresentation ? (
            <p className="presentation-exit-hint">按 Esc 退出纯净展示</p>
          ) : null}
        </section>

        <aside className="share-card-controls">
          <div>
            <p className="eyebrow">画布比例</p>
            <div className="share-aspect-options">
              {ASPECT_OPTIONS.map((option) => (
                <button
                  aria-pressed={aspect === option.id}
                  className={aspect === option.id ? 'is-selected' : ''}
                  key={option.id}
                  onClick={() => setAspect(option.id)}
                  type="button"
                >
                  <span>{aspect === option.id ? <Check size={13} /> : null}{option.label}</span>
                  <small>{option.detail}</small>
                </button>
              ))}
            </div>
          </div>

          <label className="share-evidence-toggle">
            <input
              checked={includeEvidence}
              disabled={!data.evidence}
              onChange={(event) => setIncludeEvidence(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>加入关键证据原句</strong>
              <small>
                {data.evidence
                  ? '默认关闭；打开后只加入这一条证据，不包含完整逐字稿。'
                  : '本次没有可加入的正式证据。'}
              </small>
            </span>
          </label>

          <button className="presentation-button" onClick={() => setCleanPresentation(true)} type="button">
            <Expand aria-hidden="true" size={16} />
            <span><strong>纯净展示模式</strong><small>隐藏控制区，适合投屏与截图</small></span>
          </button>

          <div className="share-export-actions">
            <p className="eyebrow">保存到本机</p>
            <button disabled={Boolean(exporting)} onClick={() => void runExport('png')} type="button">
              <Image aria-hidden="true" size={16} />
              <span><strong>{exporting === 'png' ? '正在生成…' : '导出 PNG'}</strong><small>适合直接分享</small></span>
              <Download aria-hidden="true" size={15} />
            </button>
            <button disabled={Boolean(exporting)} onClick={() => void runExport('svg')} type="button">
              <FileCode2 aria-hidden="true" size={16} />
              <span><strong>{exporting === 'svg' ? '正在生成…' : '导出 SVG'}</strong><small>可缩放、可继续编辑</small></span>
              <Download aria-hidden="true" size={15} />
            </button>
            <button disabled={Boolean(exporting)} onClick={() => void runExport('markdown')} type="button">
              <FileText aria-hidden="true" size={16} />
              <span><strong>{exporting === 'markdown' ? '正在生成…' : '导出 Markdown'}</strong><small>适合 GitHub 与笔记</small></span>
              <Download aria-hidden="true" size={15} />
            </button>
          </div>

          {error ? <p className="inline-error" role="alert">{error}</p> : null}
          <p className="share-privacy-note">
            <ShieldCheck aria-hidden="true" size={14} />
            导出由你主动触发；文件只在本机生成，Phrio 不会创建公开链接。
          </p>
        </aside>
      </main>
    </div>
  );
}
