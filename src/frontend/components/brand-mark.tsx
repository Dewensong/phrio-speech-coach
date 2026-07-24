interface BrandMarkProps {
  readonly className?: string;
  readonly title?: string;
}

export function BrandMark({ className = '', title }: BrandMarkProps) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={`brand-symbol ${className}`.trim()}
      role={title ? 'img' : undefined}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect className="brand-symbol-shell" height="31" rx="8.5" width="31" x=".5" y=".5" />
      <path
        className="brand-symbol-echo"
        d="M12.3 27V10.2h6.2c4.8 0 7.5 2.6 7.5 6.4S23.3 23 18.5 23h-2.2"
      />
      <path
        className="brand-symbol-glyph"
        d="M10.8 26.2V9h6.3c4.9 0 7.7 2.6 7.7 6.5S22 22 17.1 22h-2.7"
      />
      <circle className="brand-symbol-focus-halo" cx="24.8" cy="15.5" r="1.9" />
      <circle className="brand-symbol-focus" cx="24.8" cy="15.5" r="1.05" />
    </svg>
  );
}
