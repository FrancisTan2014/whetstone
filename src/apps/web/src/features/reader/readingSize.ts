// The reader text-size control's discrete steps. Each maps to a font-size applied to the
// reading surface via the `--reading-size` CSS variable; the steps are clamped so the
// control never produces an out-of-range size.
export const readingSizes = ["sm", "md", "lg", "xl"] as const;

export type ReadingSize = (typeof readingSizes)[number];

export const defaultReadingSize: ReadingSize = "md";

const readingSizeRem: Readonly<Record<ReadingSize, string>> = {
  lg: "1.3125rem",
  md: "1.125rem",
  sm: "1rem",
  xl: "1.5rem"
};

export function readingSizeToRem(size: ReadingSize): string {
  return readingSizeRem[size];
}

export function largerReadingSize(size: ReadingSize): ReadingSize {
  const next = readingSizes[readingSizes.indexOf(size) + 1];

  return next ?? size;
}

export function smallerReadingSize(size: ReadingSize): ReadingSize {
  const index = readingSizes.indexOf(size);

  return index <= 0 ? size : (readingSizes[index - 1] as ReadingSize);
}
