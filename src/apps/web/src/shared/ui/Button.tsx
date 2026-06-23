import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

// Token-only button styles. Variants and sizes are the single source of truth for
// interactive styling; features pick a variant rather than inventing colors. Every size
// keeps a >=44px touch target via the base `min-h-11` (44px) floor while varying padding
// and text for the visual size (`lg` raises the floor to `min-h-12`). Focus is always
// visible via the `ring` token.
export const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center rounded font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: {
      size: "md",
      variant: "primary"
    },
    variants: {
      size: {
        sm: "px-3 text-sm",
        md: "px-4 text-base",
        lg: "min-h-12 px-6 text-lg"
      },
      variant: {
        ghost: "bg-transparent text-text hover:bg-bg",
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary: "border border-border bg-surface text-text hover:bg-bg"
      }
    }
  }
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

// Buttons default to `type="button"` so they never accidentally submit a form.
export function Button({
  className,
  size,
  type,
  variant,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={buttonVariants({ className, size, variant })}
      type={type ?? "button"}
      {...rest}
    />
  );
}
