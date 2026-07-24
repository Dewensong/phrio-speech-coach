import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { HistoryItemView } from '../types/ui';

interface PracticeRecordActionsMenuProps {
  readonly item: HistoryItemView;
  readonly disabled?: boolean;
  readonly onDelete: (item: HistoryItemView) => void;
  readonly onRename: (item: HistoryItemView) => void;
  readonly onSetPinned: (item: HistoryItemView, pinned: boolean) => void;
}

interface MenuPosition {
  readonly right: number;
  readonly top: number;
}

const MENU_WIDTH = 176;
const MENU_ESTIMATED_HEIGHT = 132;
const VIEWPORT_GAP = 8;
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function currentTextScale(): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--text-scale'),
  );
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function focusAdjacentToTrigger(
  trigger: HTMLButtonElement,
  menu: HTMLElement | null,
  backwards: boolean,
): void {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((candidate) => !menu?.contains(candidate));
  const triggerIndex = candidates.indexOf(trigger);
  if (triggerIndex < 0 || candidates.length < 2) {
    trigger.focus();
    return;
  }
  const nextIndex = backwards
    ? (triggerIndex - 1 + candidates.length) % candidates.length
    : (triggerIndex + 1) % candidates.length;
  candidates[nextIndex]?.focus();
}

export function PracticeRecordActionsMenu({
  item,
  disabled = false,
  onDelete,
  onRename,
  onSetPinned,
}: PracticeRecordActionsMenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<'first' | 'last'>('first');
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = (initialFocus: 'first' | 'last' = 'first') => {
    if (disabled) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const scale = currentTextScale();
    const scaledWidth = MENU_WIDTH * scale;
    const scaledHeight = MENU_ESTIMATED_HEIGHT * scale;
    const below = rect.bottom + VIEWPORT_GAP;
    const top = below + scaledHeight <= window.innerHeight - VIEWPORT_GAP
      ? below
      : Math.max(VIEWPORT_GAP, rect.top - scaledHeight - VIEWPORT_GAP);
    initialFocusRef.current = initialFocus;
    setPosition({
      right: Math.min(
        Math.max(VIEWPORT_GAP, window.innerWidth - scaledWidth - VIEWPORT_GAP),
        Math.max(VIEWPORT_GAP, window.innerWidth - rect.right),
      ),
      top,
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const items = () => Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const initialItems = items();
    (initialFocusRef.current === 'last' ? initialItems.at(-1) : initialItems[0])?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const trigger = triggerRef.current;
        const menuElement = menuRef.current;
        setOpen(false);
        if (trigger) {
          window.requestAnimationFrame(() => {
            focusAdjacentToTrigger(trigger, menuElement, event.shiftKey);
          });
        }
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const menuItems = items();
      if (menuItems.length === 0) return;
      event.preventDefault();
      const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? menuItems.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1 + menuItems.length) % menuItems.length
            : (currentIndex - 1 + menuItems.length) % menuItems.length;
      menuItems[nextIndex]?.focus();
    };
    const closeAndReturnToTrigger = () => closeAndRestoreFocus();
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeAndReturnToTrigger);
    window.addEventListener('scroll', closeAndReturnToTrigger, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeAndReturnToTrigger);
      window.removeEventListener('scroll', closeAndReturnToTrigger, true);
    };
  }, [open]);

  const runAction = (action: () => void) => {
    setOpen(false);
    triggerRef.current?.focus();
    action();
  };

  return (
    <>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`管理“${item.title}”`}
        className="practice-record-actions-trigger"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (open) closeAndRestoreFocus();
          else openMenu('first');
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
        }}
        ref={triggerRef}
        title="记录操作"
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      {open && position ? createPortal(
        <div
          aria-label={`“${item.title}”的操作`}
          className="practice-record-actions-menu"
          id={menuId}
          ref={menuRef}
          role="menu"
          style={{ right: position.right, top: position.top }}
        >
          <button onClick={() => runAction(() => onRename(item))} role="menuitem" type="button">
            <Pencil aria-hidden="true" size={14} />重命名
          </button>
          <button
            onClick={() => runAction(() => onSetPinned(item, item.pinnedAt === null))}
            role="menuitem"
            type="button"
          >
            {item.pinnedAt ? <PinOff aria-hidden="true" size={14} /> : <Pin aria-hidden="true" size={14} />}
            {item.pinnedAt ? '取消置顶' : '置顶'}
          </button>
          <button
            className="is-dangerous"
            onClick={() => runAction(() => onDelete(item))}
            role="menuitem"
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} />删除
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
