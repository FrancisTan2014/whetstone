// Pure, framework-free zoom/pan math for the figure viewer (#381). The lightbox opens the figure
// fit-to-viewport (CSS) at scale 1; on top of that baseline the reader can zoom in (buttons / wheel /
// pinch) and pan (drag) to inspect dense diagrams. Keeping the bounded-transform logic here — with no
// React or DOM — lets the reducer be exhaustively unit-tested while `ImageLightbox` stays thin wiring.

// Fit-to-viewport is the floor: the image never zooms below the size that fills ~96vw x 92vh.
export const FIT_SCALE = 1;
// Bounded ceiling (issue: ~4-6x) so a dense diagram's labels become legible without unbounded blow-up.
export const MAX_SCALE = 5;
// Multiplicative step for the on-screen +/- controls.
export const ZOOM_STEP = 1.6;
// Gentler per-notch step for the mouse wheel.
export const WHEEL_STEP = 1.15;

export type Point = Readonly<{ x: number; y: number }>;
export type ImageSize = Readonly<{ height: number; width: number }>;
export type ZoomState = Readonly<{ offset: Point; scale: number }>;

// Fit, un-panned.
export const initialZoomState: ZoomState = { offset: { x: 0, y: 0 }, scale: FIT_SCALE };

// Clamp to [fit, max] so zoom is bounded at both ends and never distorts (uniform scale only).
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(FIT_SCALE, scale));
}

// Half the overflow of the scaled image beyond its fit box, per axis: the image may pan within
// +/-extent so it can never be dragged fully off the viewport. Zero at fit (no pan when not zoomed).
export function panExtent(baseSize: number, scale: number): number {
  return Math.max(0, (baseSize * (scale - FIT_SCALE)) / 2);
}

function clampAxis(value: number, extent: number): number {
  return Math.min(extent, Math.max(-extent, value));
}

// Clamp a desired pan offset to the current scale's bounds so the image stays on screen.
export function clampOffset(offset: Point, scale: number, size: ImageSize): Point {
  return {
    x: clampAxis(offset.x, panExtent(size.width, scale)),
    y: clampAxis(offset.y, panExtent(size.height, scale))
  };
}

// Apply a new scale (from a button, the wheel, or a pinch), re-clamping any existing pan to the new
// bounds; returning to fit snaps pan back to zero so a fit view is always centered.
export function withScale(state: ZoomState, nextScale: number, size: ImageSize): ZoomState {
  const scale = clampScale(nextScale);
  if (scale === FIT_SCALE) {
    return initialZoomState;
  }
  return { offset: clampOffset(state.offset, scale, size), scale };
}

// Apply a desired pan, clamped to the current scale's bounds.
export function withPan(state: ZoomState, next: Point, size: ImageSize): ZoomState {
  return { offset: clampOffset(next, state.scale, size), scale: state.scale };
}

// The CSS transform for the enlarged image: translate (screen px, applied after scale) then scale.
export function transformOf(state: ZoomState): string {
  return `translate(${state.offset.x}px, ${state.offset.y}px) scale(${state.scale})`;
}

// The distance between the first two active pointers, for pinch scaling; 0 when fewer than two.
export function pinchDistance(points: Iterable<Point>): number {
  const list = [...points];
  const a = list[0];
  const b = list[1];
  if (a === undefined || b === undefined) {
    return 0;
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// The transform-independent layout size of the pan reference element (the fit box); {0,0} when the
// element is not mounted, so callers need no null handling.
export function readSize(element: HTMLElement | null): ImageSize {
  if (element === null) {
    return { height: 0, width: 0 };
  }
  return { height: element.offsetHeight, width: element.offsetWidth };
}
