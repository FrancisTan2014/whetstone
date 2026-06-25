export type SpinnerProps = Readonly<{
  className?: string;
  label?: string;
}>;

// A token-styled loading spinner. It rotates via CSS under normal motion. Under reduced
// motion the global animation freeze stops the rotation, but the `loadingSpinner` class keeps
// it perceivably active with a gentle, reduced-motion-safe opacity pulse (functional status
// feedback — never a frozen, meaningless icon). Decorative by default (`aria-hidden`) when
// paired with visible text; pass a `label` to make it a standalone, announced indicator.
export function Spinner({ className, label }: SpinnerProps): React.JSX.Element {
  return (
    <svg
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      className={`loadingSpinner h-4 w-4 shrink-0 animate-spin text-current ${className ?? ""}`}
      fill="none"
      role={label === undefined ? undefined : "img"}
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        fill="none"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="4"
      />
    </svg>
  );
}
