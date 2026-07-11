import { describe, expect, it } from "vitest";

import {
  entryTypeForTimelineKind,
  entryTypes,
  groupTimelineEntriesByDay,
  isTimelineEntryKind,
  orderTimelineEntries,
  timelineDays,
  timelineEntryKinds,
  timelineKindsAreRealEntries,
  type TimelineChronology,
  type TimelineEntryKind
} from "./index.js";

type Row = TimelineChronology & { label: string };

function row(entryId: string, kind: TimelineEntryKind, occurredAt: string, label: string): Row {
  return { entryId, kind, label, occurredAt };
}

describe("timeline vocabulary", () => {
  it("names exactly the diary, note, work, recitation, and memory_note kinds", () => {
    expect(timelineEntryKinds).toEqual(["diary", "note", "work", "recitation", "memory_note"]);
  });

  it("recognizes real kinds and rejects the retired timeline-only identity", () => {
    expect(isTimelineEntryKind("diary")).toBe(true);
    expect(isTimelineEntryKind("note")).toBe(true);
    expect(isTimelineEntryKind("timeline")).toBe(false);
    expect(isTimelineEntryKind("timeline_entry")).toBe(false);
    expect(isTimelineEntryKind(undefined)).toBe(false);
  });

  it("maps each kind to a real, addressable Entry type", () => {
    expect(entryTypeForTimelineKind("diary")).toBe("diary_entry");
    expect(entryTypeForTimelineKind("note")).toBe("note");
    expect(entryTypeForTimelineKind("work")).toBe("work");
    expect(entryTypeForTimelineKind("recitation")).toBe("recitation_plan");
    expect(entryTypeForTimelineKind("memory_note")).toBe("memory_note");
  });

  it("proves the Timeline holds no entity that exists only because it appears there", () => {
    expect(timelineKindsAreRealEntries()).toBe(true);
    // Every timeline kind resolves to a member of the Entry vocabulary...
    for (const kind of timelineEntryKinds) {
      expect(entryTypes).toContain(entryTypeForTimelineKind(kind));
    }
    // ...and the retired stored-object type is gone from that vocabulary entirely.
    expect(entryTypes).not.toContain("timeline_entry");
  });
});

describe("orderTimelineEntries", () => {
  it("orders newest first by occurredAt", () => {
    const ordered = orderTimelineEntries([
      row("a", "note", "2026-01-01T08:00:00.000Z", "oldest"),
      row("b", "diary", "2026-01-03T08:00:00.000Z", "newest"),
      row("c", "note", "2026-01-02T08:00:00.000Z", "middle")
    ]);

    expect(ordered.map((entry) => entry.label)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks ties on entryId ascending so equal instants are deterministic", () => {
    const instant = "2026-01-02T08:00:00.000Z";
    const ordered = orderTimelineEntries([
      row("zeta", "note", instant, "z"),
      row("alpha", "diary", instant, "a"),
      row("mike", "note", instant, "m")
    ]);

    expect(ordered.map((entry) => entry.entryId)).toEqual(["alpha", "mike", "zeta"]);
  });

  it("is stable for entries identical in occurredAt and entryId", () => {
    const same = row("dup", "note", "2026-01-02T08:00:00.000Z", "only");
    const ordered = orderTimelineEntries([same, same]);

    expect(ordered).toEqual([same, same]);
  });

  it("does not mutate the input array", () => {
    const input = [
      row("a", "note", "2026-01-01T08:00:00.000Z", "oldest"),
      row("b", "diary", "2026-01-03T08:00:00.000Z", "newest")
    ];
    const snapshot = [...input];

    orderTimelineEntries(input);

    expect(input).toEqual(snapshot);
  });
});

describe("groupTimelineEntriesByDay", () => {
  it("groups into UTC days, newest day first, ordered within each day", () => {
    const days = groupTimelineEntriesByDay([
      row("n1", "note", "2026-01-01T23:00:00.000Z", "jan1-note"),
      row("d2", "diary", "2026-01-03T06:00:00.000Z", "jan3-diary-early"),
      row("d1", "diary", "2026-01-03T09:00:00.000Z", "jan3-diary-late"),
      row("n2", "note", "2026-01-02T12:00:00.000Z", "jan2-note")
    ]);

    expect(days.map((day) => day.date)).toEqual(["2026-01-03", "2026-01-02", "2026-01-01"]);
    // Within 2026-01-03, later instant first; the tie-break never triggers here because instants differ.
    expect(days[0]?.entries.map((entry) => entry.label)).toEqual([
      "jan3-diary-late",
      "jan3-diary-early"
    ]);
    expect(days[1]?.entries.map((entry) => entry.label)).toEqual(["jan2-note"]);
    expect(days[2]?.entries.map((entry) => entry.label)).toEqual(["jan1-note"]);
  });

  it("buckets by the UTC calendar day the instant falls on", () => {
    // 2026-01-02T00:30 UTC is still Jan 2 in UTC even though it is Jan 1 evening in some local zones.
    const days = groupTimelineEntriesByDay([
      row("late", "diary", "2026-01-02T00:30:00.000Z", "after-midnight"),
      row("early", "note", "2026-01-01T23:30:00.000Z", "before-midnight")
    ]);

    expect(days.map((day) => day.date)).toEqual(["2026-01-02", "2026-01-01"]);
  });

  it("returns no days for no entries", () => {
    expect(groupTimelineEntriesByDay([])).toEqual([]);
  });
});

describe("timelineDays", () => {
  it("lists distinct days newest first", () => {
    const days = timelineDays([
      row("a", "note", "2026-01-01T10:00:00.000Z", "a"),
      row("b", "diary", "2026-01-03T10:00:00.000Z", "b"),
      row("c", "note", "2026-01-03T18:00:00.000Z", "c")
    ]);

    expect(days).toEqual(["2026-01-03", "2026-01-01"]);
  });
});
