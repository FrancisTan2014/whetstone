import { describe, expect, it } from "vitest";

import {
  groupByDayDesc,
  isDayKey,
  monthBounds,
  monthGrid,
  shiftMonth,
  toDayKey,
  toMonthKey
} from "./diaryTimeline.js";

describe("toDayKey", () => {
  it("formats a date as a zero-padded UTC YYYY-MM-DD key", () => {
    expect(toDayKey(new Date("2026-06-30T20:38:00.000Z"))).toBe("2026-06-30");
    expect(toDayKey(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
    expect(toDayKey(new Date("0099-09-09T12:00:00.000Z"))).toBe("0099-09-09");
  });

  it("reads the day in UTC so the same instant maps to one day everywhere", () => {
    expect(toDayKey(new Date("2026-06-30T23:59:59.999Z"))).toBe("2026-06-30");
  });
});

describe("isDayKey", () => {
  it("accepts a well-formed day key and rejects malformed ones", () => {
    expect(isDayKey("2026-06-30")).toBe(true);
    expect(isDayKey("2026-6-30")).toBe(false);
    expect(isDayKey("2026-06-30T00:00")).toBe(false);
    expect(isDayKey("not-a-date")).toBe(false);
  });
});

describe("toMonthKey", () => {
  it("takes the YYYY-MM prefix of a day key", () => {
    expect(toMonthKey("2026-06-30")).toBe("2026-06");
  });
});

describe("groupByDayDesc", () => {
  it("groups entries by day, newest day first, oldest-first within a day", () => {
    const groups = groupByDayDesc([
      { createdAt: "2026-06-29T09:00:00.000Z", date: "2026-06-29", id: "a" },
      { createdAt: "2026-06-30T10:00:00.000Z", date: "2026-06-30", id: "b" },
      { createdAt: "2026-06-30T08:00:00.000Z", date: "2026-06-30", id: "c" }
    ]);

    expect(groups.map((group) => group.date)).toEqual(["2026-06-30", "2026-06-29"]);
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(["c", "b"]);
    expect(groups[1]?.entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("keeps a stable order for entries sharing a timestamp", () => {
    const groups = groupByDayDesc([
      { createdAt: "2026-06-30T08:00:00.000Z", date: "2026-06-30", id: "first" },
      { createdAt: "2026-06-30T08:00:00.000Z", date: "2026-06-30", id: "second" }
    ]);

    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("returns no groups for an empty input", () => {
    expect(groupByDayDesc([])).toEqual([]);
  });
});

describe("monthBounds", () => {
  it("returns the first and last day keys of a 31-day month", () => {
    expect(monthBounds("2026-07")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("handles February in a leap year", () => {
    expect(monthBounds("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("handles February in a common year", () => {
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("rejects a malformed month key", () => {
    expect(() => monthBounds("2026-6")).toThrow("Invalid month key");
  });
});

describe("shiftMonth", () => {
  it("moves forward and backward across year boundaries", () => {
    expect(shiftMonth("2026-06", 1)).toBe("2026-07");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-06", 0)).toBe("2026-06");
  });
});

describe("monthGrid", () => {
  it("lays out a month as Sunday-first weeks padded with nulls", () => {
    const weeks = monthGrid("2026-02");

    // 2026-02-01 is a Sunday, so the first cell is the 1st with no leading blanks.
    expect(weeks[0]?.[0]).toBe("2026-02-01");
    expect(weeks).toHaveLength(4);
    expect(weeks.at(-1)?.at(-1)).toBe("2026-02-28");
    expect(weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("pads leading blanks for a month that does not start on Sunday", () => {
    const weeks = monthGrid("2026-07");

    // 2026-07-01 is a Wednesday (weekday 3): three leading null cells.
    expect(weeks[0]?.slice(0, 4)).toEqual([null, null, null, "2026-07-01"]);
    expect(weeks.flat().filter((cell) => cell !== null)).toHaveLength(31);
    expect(weeks.flat().at(-1)).toBeNull();
  });
});
