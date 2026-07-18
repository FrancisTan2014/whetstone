import { describe, expect, it } from "vitest";

import { activeDestination, navDestinations } from "./navigation";

describe("navDestinations", () => {
  it("lists exactly the five primary destinations in order (#638)", () => {
    expect(navDestinations.map((destination) => destination.label)).toEqual([
      "Today",
      "Library",
      "Recite",
      "Notes",
      "Diary"
    ]);
    expect(navDestinations.map((destination) => destination.to)).toEqual([
      "/",
      "/library",
      "/recite",
      "/notes",
      "/diary"
    ]);
  });

  it("marks only Today as an exact-match (end) destination (#638)", () => {
    expect(navDestinations.filter((destination) => destination.end)).toHaveLength(1);
    expect(navDestinations.find((destination) => destination.end)?.to).toBe("/");
  });
});

describe("activeDestination", () => {
  it("owns the index route only for Today on an exact match (#638)", () => {
    expect(activeDestination("/")).toBe("/");
  });

  it("keeps each primary destination active on its own route", () => {
    expect(activeDestination("/library")).toBe("/library");
    expect(activeDestination("/recite")).toBe("/recite");
    expect(activeDestination("/notes")).toBe("/notes");
    expect(activeDestination("/diary")).toBe("/diary");
  });

  it("maps secondary Reader and Write routes to Library (#638)", () => {
    expect(activeDestination("/reader")).toBe("/library");
    expect(activeDestination("/reader/work-1")).toBe("/library");
    expect(activeDestination("/write")).toBe("/library");
  });

  it("maps the secondary Recitation review to Recite (#638)", () => {
    expect(activeDestination("/recitation")).toBe("/recite");
    expect(activeDestination("/recitation/session")).toBe("/recite");
  });

  it("maps the secondary note Review and retired Memory/Recall routes to Notes (#638)", () => {
    expect(activeDestination("/notes/review")).toBe("/notes");
    expect(activeDestination("/memory")).toBe("/notes");
    expect(activeDestination("/recall")).toBe("/notes");
  });

  it("ignores a trailing slash when resolving the parent", () => {
    expect(activeDestination("/library/")).toBe("/library");
    expect(activeDestination("/recite/")).toBe("/recite");
  });

  it("owns no destination for the Search utility or an unknown route (#638)", () => {
    expect(activeDestination("/search")).toBeNull();
    expect(activeDestination("/nowhere")).toBeNull();
  });
});
