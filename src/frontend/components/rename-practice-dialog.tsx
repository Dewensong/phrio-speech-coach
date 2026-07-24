import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { MAX_PRACTICE_RECORD_TITLE_LENGTH } from '../../shared';
import type { HistoryItemView } from '../types/ui';

interface RenamePracticeDialogProps {
  readonly busy?: boolean;
  readonly error?: string;
  readonly item: HistoryItemView;
  readonly onCancel: () => void;
  readonly onConfirm: (title: string) => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function RenamePracticeDialog({
  busy = false,
  error,
  item,
  onCancel,
  onConfirm,
}: RenamePracticeDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  const [value, setValue] = useState(item.title);
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const validationError = normalized.length === 0
    ? '名称不能为空。'
    : normalized.length > MAX_PRACTICE_RECORD_TITLE_LENGTH
      ? `名称不能超过 ${MAX_PRACTICE_RECORD_TITLE_LENGTH} 个字符。`
      : null;
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    inputRef.current?.focus();
    inputRef.current?.select();
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = focusableElements(dialog);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || validationError) return;
    onConfirm(normalized);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirmation-dialog rename-practice-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id={titleId}>重命名练习记录</h2>
        <p id={descriptionId}>名称只影响记录列表，不会改动逐字稿、任务或诊断结果。</p>
        <form onSubmit={submit}>
          <label htmlFor={`${titleId}-input`}>记录名称</label>
          <input
            aria-describedby={validationError || error ? `${titleId}-error` : undefined}
            aria-invalid={Boolean(validationError || error)}
            disabled={busy}
            id={`${titleId}-input`}
            maxLength={MAX_PRACTICE_RECORD_TITLE_LENGTH + 1}
            onChange={(event) => setValue(event.target.value)}
            ref={inputRef}
            value={value}
          />
          {validationError || error ? (
            <p className="inline-error" id={`${titleId}-error`} role="alert">{validationError ?? error}</p>
          ) : null}
          <div className="page-actions">
            <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">取消</button>
            <button className="primary-button" disabled={busy || Boolean(validationError)} type="submit">
              {busy ? '正在保存…' : '保存名称'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
