import * as Dialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

import { motionSprings, withReducedMotion } from "../motion/motion.js";
import { FloatingLayerProvider } from "./FloatingLayer.js";
import { useMediaQuery } from "./useMediaQuery.js";

type SheetSide = "right" | "bottom";

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

  // The above-overlay host every editor floating surface portals into (#645). It lives INSIDE
  // `Dialog.Content`, so Radix keeps it out of the `aria-hidden` sweep and inside the FocusScope (menus
  // stay reachable), while its un-transformed, un-clipped coordinate space lets floating-ui position a
  // BubbleMenu against viewport-space selection rects without the panel's transform/`overflow: hidden`
  // mispositioning or clipping it. The node is created once by a lazy state initializer (never touching
  // a ref during render) so it is a stable, non-null container from the very first render: the slash
  // menu resolves its container once, when the editor is created — earlier than a ref callback would
  // publish the node — so an eager host is what makes the slash menu (and every surface) land inside the
  // dialog rather than the body.
  const [floatingHost] = useState<HTMLDivElement>(() => {
    const host = document.createElement("div");
    host.className = "sheet-floating-layer";
    return host;
  });

  // Attach the eager host as the last child of the (un-transformed, un-clipped) content root, so its
  // surfaces paint above the panel with no explicit z-index. A callback ref re-attaches it whenever the
  // content root mounts (e.g. the sheet reopens); the node itself persists across those remounts.
  const attachContentRoot = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) {
        node.appendChild(floatingHost);
      }
    },
    [floatingHost]
  );

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          asChild
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
          onOpenAutoFocus={() => {
            openerRef.current = document.activeElement as HTMLElement | null;
          }}
        >
          {/* The outer content root is un-transformed, un-clipped, and click-through: it sits above the
              overlay (its own stacking context) so both the panel and the floating host paint above the
              scrim, but pointer events fall through its empty area to the overlay so outside-click
              dismissal still works. The visible panel and the floating host re-enable pointer events. */}
          <div className="sheet-content-root" data-side={resolvedSide} ref={attachContentRoot}>
            <motion.div
              animate={isRight ? { x: 0 } : { y: 0 }}
              className={
                isRight ? "sheet-panel sheet-panel-right" : "sheet-panel sheet-panel-bottom"
              }
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
              <div className="sheet-body">
                <FloatingLayerProvider container={floatingHost}>{children}</FloatingLayerProvider>
              </div>
            </motion.div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
