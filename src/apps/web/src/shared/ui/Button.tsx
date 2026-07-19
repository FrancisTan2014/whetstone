import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, Ref } from "react";

import { Spinner } from "./Spinner.js";

// Token-only button styles. Variants and sizes are the single source of truth for
// interactive styling; features pick a variant rather than inventing colors. Every size
// keeps a >=44px touch target via the base `min-h-11` (44px) floor while varying padding
// and text for the visual size (`lg` raises the floor to `min-h-12`). Focus is always
// visible via the `ring` token.
export const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: {
      size: "md",
      variant: "primary"
    },
    variants: {
      size: {
        sm: "px-3 text-sm",
        md: "px-4 text-base",
        lg: "min-h-12 px-6 text-lg",
        // A square 44x44 icon-only target: the base `min-h-11` floor plus a matching `min-w-11` and no
        // horizontal padding so a single centered icon keeps a full WCAG 2.5.5 hit target (#641).
        icon: "min-w-11 px-0"
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
  VariantProps<typeof buttonVariants> &
  Readonly<{ pending?: boolean; ref?: Ref<HTMLButtonElement> }>;

// Buttons default to `type="button"` so they never accidentally submit a form. When
// `pending`, the button shows a spinner, reports `aria-busy`, and is disabled so an
// in-flight action cannot be double-submitted. The optional `ref` (a plain prop in React 19)
// lets callers manage focus and lets Radix `asChild` triggers anchor to the real element.
export function Button({
  children,
  className,
  disabled,
  pending,
  ref,
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
      ref={ref}
      aria-busy={pending}
      disabled={disabled === true || pending === true}
    >
      {pending === true ? <Spinner /> : null}
      {children}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, "aria-label" | "children" | "size"> &
  Readonly<{ icon: React.ReactNode; label: string; title?: string }>;

// The icon-only form of the shared Button boundary (#641): it reuses Button's variants, 44px target, and
// visible focus ring rather than re-declaring them, and forces a `label` so every icon-only control has a
// specific accessible name plus a hover tooltip (the `title`, defaulting to the label). Callers pass a
// single Lucide icon (20px, `strokeWidth={1.75}`, decorative) — never a bare glyph.
export function IconButton({ icon, label, title, ...rest }: IconButtonProps): React.JSX.Element {
  return (
    <Button {...rest} aria-label={label} size="icon" title={title ?? label}>
      {icon}
    </Button>
  );
}
