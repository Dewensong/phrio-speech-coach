import { useRef, type KeyboardEvent } from 'react';

export interface SegmentedTabOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

interface SegmentedTabsProps<Value extends string> {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly idBase: string;
  readonly onChange: (value: Value) => void;
  readonly options: readonly SegmentedTabOption<Value>[];
  readonly value: Value;
}

export function SegmentedTabs<Value extends string>({
  ariaLabel,
  className,
  idBase,
  onChange,
  options,
  value,
}: SegmentedTabsProps<Value>) {
  const triggers = useRef(new Map<Value, HTMLButtonElement>());

  const move = (event: KeyboardEvent<HTMLButtonElement>, current: Value) => {
    const enabled = options.filter((option) => !option.disabled);
    const currentIndex = enabled.findIndex((option) => option.value === current);
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % enabled.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = enabled.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = enabled[nextIndex]!;
    onChange(next.value);
    triggers.current.get(next.value)?.focus();
  };

  return (
    <div className={className} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          aria-controls={`${idBase}-panel-${option.value}`}
          aria-selected={value === option.value}
          disabled={option.disabled}
          id={`${idBase}-tab-${option.value}`}
          key={option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => move(event, option.value)}
          ref={(element) => {
            if (element) triggers.current.set(option.value, element);
            else triggers.current.delete(option.value);
          }}
          role="tab"
          tabIndex={value === option.value ? 0 : -1}
          type="button"
        >
          <strong>{option.label}</strong>
          {option.description ? <small>{option.description}</small> : null}
        </button>
      ))}
    </div>
  );
}
