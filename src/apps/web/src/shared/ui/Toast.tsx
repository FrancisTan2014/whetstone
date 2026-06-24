import { motion } from "framer-motion";

import { motionSprings, withReducedMotion } from "../motion/motion.js";
import type { ToastIntent } from "./toast/ToastProvider.js";

export type ToastProps = Readonly<{
  intent: ToastIntent;
  message: string;
  onDismiss: () => void;
  prefersReducedMotion: boolean;
}>;

// Token-only intent styling; success and error share the surface and differ only in the
// border/text accent so both stay legible in Day and Night.
const intentClassName: Record<ToastIntent, string> = {
  error: "border-danger text-danger",
  success: "border-success text-success"
};

// A single transient result notification. Success announces politely (role="status"),
// error assertively (role="alert"); both spring in/out (instant under reduced motion) and
// can be dismissed from the keyboard via the close button (>=44px target, visible focus).
export function Toast({
  intent,
  message,
  onDismiss,
  prefersReducedMotion
}: ToastProps): React.JSX.Element {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={`pointer-events-auto flex items-center gap-3 rounded border bg-surface px-4 py-2 font-medium shadow-lg ${intentClassName[intent]}`}
      initial={{ opacity: 0, y: 8 }}
      role={intent === "error" ? "alert" : "status"}
      transition={withReducedMotion(motionSprings.snappy, prefersReducedMotion)}
    >
      <span>{message}</span>
      <button
        aria-label="Dismiss notification"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-text-muted hover:text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={onDismiss}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          focusable="false"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </motion.div>
  );
}
