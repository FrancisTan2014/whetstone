import * as Dialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";

import { motionSprings, withReducedMotion } from "../motion/motion.js";
import { useMediaQuery } from "./useMediaQuery.js";

export type SheetSide = "right" | "bottom";

export type SheetProps = Readonly<{
  children: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  // Overrides the responsive default (right on desktop, bottom on mobile).
  side?: SheetSide;
  title: string;
}>;

// A responsive dialog: a right-docked side panel on desktop and a bottom sheet on
// mobile. Radix provides the focus trap, escape/overlay dismissal, and labelling; the
// enter spring is tokenized and honors reduced motion (both the explicit guard here and
// the global `MotionConfig reducedMotion="user"`).
export function Sheet({
  children,
  onOpenChange,
  open,
  side,
  title
}: SheetProps): React.JSX.Element {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const resolvedSide: SheetSide = side ?? (isDesktop ? "right" : "bottom");
  const isRight = resolvedSide === "right";
  const prefersReducedMotion = Boolean(useReducedMotion());
  const transition = withReducedMotion(motionSprings.gentle, prefersReducedMotion);

  // Restore focus to the control that opened the sheet when it closes — so keyboard users land back on a
  // usable control instead of <body> (#469). The opener is captured on open (before Radix moves focus into
  // the panel), then refocused both on a Radix close transition AND on unmount. The unmount path is the
  // load-bearing one: callers often render the sheet only while open (`{open ? <Sheet open/> : null}`), so
  // it is UNMOUNTED while still open and Radix's own close-time restore never runs.
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocus = (): void => {
    const opener = openerRef.current;
    if (opener !== null && opener.isConnected) {
      opener.focus({ preventScroll: true });
    }
  };
  useEffect(() => restoreFocus, []);

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          asChild
          className={isRight ? "sheet-panel sheet-panel-right" : "sheet-panel sheet-panel-bottom"}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
          onOpenAutoFocus={() => {
            openerRef.current = document.activeElement as HTMLElement | null;
          }}
        >
          <motion.div
            animate={isRight ? { x: 0 } : { y: 0 }}
            data-side={resolvedSide}
            initial={isRight ? { x: "100%" } : { y: "100%" }}
            transition={transition}
          >
            <header className="sheet-header flex items-center justify-between gap-4">
              <Dialog.Title className="text-lg font-semibold text-text">{title}</Dialog.Title>
              <Dialog.Close
                aria-label="Close"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-text-muted hover:text-text"
              >
                ✕
              </Dialog.Close>
            </header>
            <div className="sheet-body">{children}</div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
