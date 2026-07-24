const STAGES = [
  { label: '初讲', optionalLabel: null },
  { label: '诊断 / 聚焦训练', optionalLabel: '聚焦可选' },
  { label: '复讲', optionalLabel: '可选' },
  { label: '对比', optionalLabel: '可选' },
] as const;

interface StageRailProps {
  activeIndex: number;
}

export function StageRail({ activeIndex }: StageRailProps) {
  return (
    <ol className="stage-rail" aria-label="练习进度">
      {STAGES.map((stage, index) => {
        const complete = index < activeIndex;
        const active = index === activeIndex;
        return (
          <li
            className={active ? 'is-active' : complete ? 'is-complete' : ''}
            key={stage.label}
            aria-current={active ? 'step' : undefined}
          >
            <span className="stage-dot" aria-hidden="true" />
            <span className="stage-number">{index + 1}</span>
            <span>{stage.label}</span>
            {stage.optionalLabel ? (
              <small className="stage-optionality">{stage.optionalLabel}</small>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
