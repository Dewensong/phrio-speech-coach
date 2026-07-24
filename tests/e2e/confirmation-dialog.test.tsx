import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmationDialog } from '../../src/frontend/components/confirmation-dialog';

afterEach(cleanup);

describe('accessible confirmation dialog', () => {
  it('contains keyboard focus, cancels with Escape, and restores the trigger', () => {
    const onCancel = vi.fn();
    const trigger = document.createElement('button');
    trigger.textContent = '触发操作';
    document.body.append(trigger);
    trigger.focus();

    const view = render(
      <ConfirmationDialog
        cancelLabel="取消"
        confirmDangerous
        confirmLabel="确认删除"
        description="此操作需要明确确认。"
        onCancel={onCancel}
        onConfirm={vi.fn()}
        title="确认操作？"
      />,
    );

    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '确认删除' });
    expect(cancel).toHaveFocus();

    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('does not dismiss a busy destructive decision with Escape', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmationDialog
        busy
        cancelLabel="保留"
        confirmLabel="处理中…"
        description="正在完成原子操作。"
        onCancel={onCancel}
        onConfirm={vi.fn()}
        title="正在处理"
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
