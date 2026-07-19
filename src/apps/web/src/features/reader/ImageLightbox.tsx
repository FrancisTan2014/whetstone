import * as Dialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState, type WheelEvent } from "react";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";
import {
  FIT_SCALE,
  initialZoomState,
  MAX_SCALE,
  type Point,
  pinchDistance,
  readSize,
  transformOf,
  WHEEL_STEP,
  withPan,
  withScale,
  ZOOM_STEP
} from "./figureZoom.js";

export type ImageLightboxProps = Readonly<{
  alt: string;
  // The figure's caption (plain text), shown beneath the enlarged image when present.
  caption: string;
  // Runtime image-load failure on the inline trigger image; the figure then degrades to caption-only.
  onError: () => void;
  src: string;
}>;

// A view-only image lightbox (#334, #381): the figure image is a real focusable button that opens a
// centered modal over a dimmed + blurred backdrop. The enlarged image is ENLARGED TO FIT the viewport
// (scaling small sources up, not only down — the CSS `.lightbox-image` fills ~96vw x 92vh with
// `object-fit: contain`), and on top of that fit the reader can ZOOM IN (on-screen +/- controls, mouse
// wheel, or pinch) and PAN (drag) to read dense diagram labels, with a reset-to-fit control. Zoom is
// bounded (fit .. MAX_SCALE) and never distorts; pan is clamped so the image can't leave the viewport.
// Built on `@radix-ui/react-dialog` (focus trap, Escape + backdrop-click dismissal, body scroll-lock,
// portal, ARIA labelling, focus-return to the trigger). Dismissal stays unambiguous: Escape and the
// close button always dismiss, a click on the scrim outside the image dismisses, but a drag on the image
// pans (it stays inside the dialog content, so it never triggers a backdrop close). No route change and
// no server call — the same cached `/api/images/:id` bytes render enlarged. Zoom/pan use a dependency-
// free bounded CSS transform (measured: the react-zoom-pan-pinch library did not fit the JS bundle
// budget), and all motion honors reduced motion via the global reduced-motion CSS policy.
export function ImageLightbox({
  alt,
  caption,
  onError,
  src
}: ImageLightboxProps): React.JSX.Element {
  const prefersReducedMotion = Boolean(useReducedMotion());
  // Under reduced motion `withReducedMotion` returns an instant (duration-0) transition, so the fade +
  // slight scale-in snaps into place with no animation — honoring criterion 7 without a separate motion
  // shape to branch on.
  const transition = withReducedMotion(motionSprings.gentle, prefersReducedMotion);
  const triggerLabel = alt.trim().length > 0 ? `View larger: ${alt}` : "View image larger";
  const dialogLabel = alt.trim().length > 0 ? alt : "Enlarged image";
  const hasCaption = caption.trim().length > 0;

  const [zoomState, setZoomState] = useState(initialZoomState);
  // True while a pointer gesture is in flight, so CSS can drop the transform transition and track the
  // finger/cursor crisply during a pan or pinch (discrete button/wheel zoom keeps the smooth transition).
  const [interacting, setInteracting] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Active pointers (id -> last position) drive pinch; a single pointer drives pan.
  const pointersRef = useRef(new Map<number, Point>());
  // The last measured pinch span; 0 when not pinching (or the two fingers coincide).
  const pinchRef = useRef(0);
  // Where a drag-to-pan started, plus the pan offset at that moment.
  const panStartRef = useRef<{ offset: Point; pointer: Point } | null>(null);

  const zoomTo = (nextScale: number): void => {
    setZoomState((state) => withScale(state, nextScale, readSize(viewportRef.current)));
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    setZoomState((state) => withScale(state, state.scale * factor, readSize(event.currentTarget)));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setInteracting(true);
    if (pointers.size >= 2) {
      pinchRef.current = pinchDistance(pointers.values());
      panStartRef.current = null;
    } else {
      panStartRef.current = {
        offset: zoomState.offset,
        pointer: { x: event.clientX, y: event.clientY }
      };
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) {
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const size = readSize(event.currentTarget);

    if (pointers.size >= 2) {
      const span = pinchDistance(pointers.values());
      const ratio = pinchRef.current === 0 ? 1 : span / pinchRef.current;
      pinchRef.current = span;
      setZoomState((state) => withScale(state, state.scale * ratio, size));
      return;
    }

    const start = panStartRef.current;
    if (start !== null) {
      const next: Point = {
        x: start.offset.x + (event.clientX - start.pointer.x),
        y: start.offset.y + (event.clientY - start.pointer.y)
      };
      setZoomState((state) => withPan(state, next, size));
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pointers = pointersRef.current;
    pointers.delete(event.pointerId);
    // Any lift ends the current pinch baseline (the viewer tracks at most two pointers).
    pinchRef.current = 0;
    if (pointers.size === 0) {
      panStartRef.current = null;
      setInteracting(false);
    }
  };

  const zoomedIn = zoomState.scale > FIT_SCALE;

  // The viewer always (re)opens at fit. `zoomState` and the gesture refs live on this always-mounted
  // component (the trigger stays rendered), so without this Radix leaves them intact across a close —
  // reopening the same figure would show the previous zoom/pan. Reset them whenever the dialog opens or
  // closes so every open starts at the fit-to-viewport baseline (#381).
  const handleOpenChange = (): void => {
    setZoomState(initialZoomState);
    setInteracting(false);
    pointersRef.current.clear();
    pinchRef.current = 0;
    panStartRef.current = null;
  };

  return (
    <Dialog.Root onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button aria-label={triggerLabel} className="readerFigureTrigger" type="button">
          <img
            alt={alt}
            className="readerFigureImage"
            draggable={false}
            loading="lazy"
            onError={onError}
            src={src}
          />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="lightbox-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          aria-label={dialogLabel}
          asChild
          className="lightbox-content"
        >
          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            initial={{ opacity: 0, scale: 0.96 }}
            transition={transition}
          >
            <Dialog.Close aria-label="Close" className="lightbox-close" type="button">
              <X aria-hidden size={20} strokeWidth={1.75} />
            </Dialog.Close>
            <div
              className="lightbox-viewport"
              data-interacting={String(interacting)}
              data-zoomed={String(zoomedIn)}
              onPointerCancel={endPointer}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endPointer}
              onWheel={handleWheel}
              ref={viewportRef}
            >
              <img
                alt={alt}
                className="lightbox-image"
                data-zoom={zoomState.scale}
                draggable={false}
                src={src}
                style={{ transform: transformOf(zoomState) }}
              />
            </div>
            <div className="lightbox-controls">
              <button
                aria-label="Zoom out"
                className="lightbox-control"
                disabled={!zoomedIn}
                onClick={() => {
                  zoomTo(zoomState.scale / ZOOM_STEP);
                }}
                type="button"
              >
                −
              </button>
              <button
                aria-label="Reset zoom to fit"
                className="lightbox-control"
                disabled={!zoomedIn}
                onClick={() => {
                  setZoomState(initialZoomState);
                }}
                type="button"
              >
                ⤢
              </button>
              <button
                aria-label="Zoom in"
                className="lightbox-control"
                disabled={zoomState.scale >= MAX_SCALE}
                onClick={() => {
                  zoomTo(zoomState.scale * ZOOM_STEP);
                }}
                type="button"
              >
                +
              </button>
            </div>
            {hasCaption ? <p className="lightbox-caption">{caption}</p> : null}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
