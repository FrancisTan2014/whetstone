import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

// Token-only button styles. Variants and sizes are the single source of truth for
// interactive styling; features pick a variant rather than inventing colors. Sizes keep
// a >=44px touch target (`h-11`/`h-12`). Focus is always visible via the `ring` token.
export const buttonVariants = cva(
  "inline-flex items-center justify-center rounded font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: {
      size: "md",
      variant: "primary"
    },
    variants: {
      size: {
        sm: "h-9 px-3 text-sm",
        md: "h-11 px-4 text-base",
        lg: "h-12 px-6 text-lg"
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
