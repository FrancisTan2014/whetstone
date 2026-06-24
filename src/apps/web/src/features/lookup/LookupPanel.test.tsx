// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LookupPanel, type LookupState } from "./LookupPanel";

function renderPanel(state: LookupState): void {
  render(<LookupPanel onOpenChange={() => undefined} open={true} state={state} term="set" />);
}

afterEach(() => {
  cleanup();
});

describe("LookupPanel", () => {
  it("titles the sheet with the looked-up term", () => {
    renderPanel({ status: "loading" });

    expect(screen.getByText("Look up: set")).toBeDefined();
  });

  it("shows a loading state while fetching", () => {
    renderPanel({ status: "loading" });

    expect(screen.getByRole("status").textContent).toContain("Looking up");
  });

  it("shows an error state when the lookup fails", () => {
    renderPanel({ status: "error" });

    expect(screen.getByRole("alert").textContent).toContain("Could not look up");
  });

  it("shows an empty state when no definition is found", () => {
    renderPanel({ status: "empty" });

    expect(screen.getByText("No definition found.")).toBeDefined();
  });

  it("renders the headword, pronunciation, senses, and attribution when loaded", () => {
    renderPanel({
      attribution: "From a source.",
      entry: {
        headword: "set",
        pronunciation: "/sɛt/",
        senses: [
          { example: "set it down", gloss: "to put in place", partOfSpeech: "verb" },
          { gloss: "a group of things" }
        ]
      },
      status: "loaded"
    });

    expect(screen.getByText("set")).toBeDefined();
    expect(screen.getByText("/sɛt/")).toBeDefined();
    expect(screen.getByText("verb")).toBeDefined();
    expect(screen.getByText("to put in place")).toBeDefined();
    expect(screen.getByText("“set it down”")).toBeDefined();
    expect(screen.getByText("a group of things")).toBeDefined();
    expect(screen.getByText("From a source.")).toBeDefined();
  });

  it("omits pronunciation, part of speech, example, and attribution when absent", () => {
    renderPanel({
      entry: { headword: "set", senses: [{ gloss: "a group of things" }] },
      status: "loaded"
    });

    expect(screen.getByText("a group of things")).toBeDefined();
    expect(screen.queryByText("From a source.")).toBeNull();
  });
});
