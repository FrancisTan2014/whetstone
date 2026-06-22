export const workTypes = ["book", "essay", "blog_post", "classical_text"] as const;

export type WorkType = (typeof workTypes)[number];

const workTypeSet: ReadonlySet<unknown> = new Set(workTypes);

export function isWorkType(value: unknown): value is WorkType {
  return workTypeSet.has(value);
}
