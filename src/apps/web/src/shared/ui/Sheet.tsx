import * as Dialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";

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

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          asChild
          className={isRight ? "sheet-panel sheet-panel-right" : "sheet-panel sheet-panel-bottom"}
        >
          <motion.div
            animate={isRight ? { x: 0 } : { y: 0 }}
            data-side={resolvedSide}
            initial={isRight ? { x: "100%" } : { y: "100%" }}
            transition={transition}
          >
            <header className="flex items-center justify-between gap-4">
              <Dialog.Title className="text-lg font-semibold text-text">{title}</Dialog.Title>
              <Dialog.Close
                aria-label="Close"
                className="rounded px-2 py-1 text-text-muted hover:text-text"
              >
                ✕
              </Dialog.Close>
            </header>
            {children}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
