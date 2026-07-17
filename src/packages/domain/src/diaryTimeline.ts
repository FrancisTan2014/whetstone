// Day-key validation for the diary Timeline (#246, #648). The Timeline pages by an exclusive `before`
// day-key cursor and every day/date the API accepts is a `YYYY-MM-DD` key, so the one piece of product
// logic worth isolating is recognising a well-formed day key at the boundary. The instant → local-day-key
// projection lives in the shared local-day boundary (`localDayKey`, #606) so every routine derives "the
// day" from the learner's one timezone; day-grouping lives in the shared Timeline helper
// (`groupTimelineEntriesByDay`, #571). Operates on day KEYS (strings), so it is timezone-independent. No
// persistence, React, or I/O.

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Whether a string is a well-formed `YYYY-MM-DD` day key. Used at the API boundary to reject a malformed
// cursor/range before it reaches a query.
export function isDayKey(value: string): boolean {
  return DAY_KEY_PATTERN.test(value);
}
