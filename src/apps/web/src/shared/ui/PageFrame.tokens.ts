/* v8 ignore file — pure token map (page-frame content width → max-width utility), exercised via PageFrame behavior. */

// The two — and only two (#641) — content widths a standard page may choose. `focused` (42rem) is the
// single-column task width (Today, Recite, Notes, Diary, Review, and settings-like tasks); `collection`
// (64rem) is reserved for genuine multi-column collections (Library). Both are viewport-capped because
// the frame is `w-full` and only these caps limit growth.
export type PageFrameWidth = "collection" | "focused";

export const pageFrameWidthClass: Readonly<Record<PageFrameWidth, string>> = {
  collection: "max-w-[64rem]",
  focused: "max-w-[42rem]"
};
