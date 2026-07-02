// @vitest-environment jsdom
import { render, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "./App";

// jsdom (above) so the shell-mounted ThemeToggle can read `window` (localStorage /
// matchMedia, provided by the test setup) while we still server-render the markup.
function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

// Live render (jsdom) so we can query the Primary nav landmark and assert exactly which links it
// contains — the route content (e.g. Today's "Recall"/"Practice" cards) shares those words, so the
// "removed from primary nav" invariant (#390) must be scoped to the nav, not the whole document.
function renderLiveAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("App shell and routes", () => {
  it("shows exactly the five primary destinations in the nav (#390)", () => {
    const { getByRole } = renderLiveAt("/");
    const nav = getByRole("navigation", { name: "Primary" });

    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels).toEqual(["Today", "Library", "Practice", "Map", "Search"]);
  });

  it("keeps Reader, Recall, Notes, Diary, and Progress out of the primary nav (#390)", () => {
    const { getByRole } = renderLiveAt("/");
    const nav = getByRole("navigation", { name: "Primary" });

    for (const secondary of ["Reader", "Recall", "Notes", "Diary", "Progress"]) {
      expect(within(nav).queryByRole("link", { name: secondary })).toBeNull();
    }
  });

  it("gives the theme toggle a home in the shell", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-label="Switch to Night"');
  });

  it("mounts the single toast live region in the shell", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-label="Notifications"');
  });

  it("marks the active destination at the index route", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-current="page"');
  });

  it("lands on the proactive Today home at the index route", () => {
    const markup = renderAt("/");

    expect(markup).toContain('id="today-heading"');
    expect(markup).toContain("Capture a thought");
    // Today is the landing now — the Library no longer mounts at the index route.
    expect(markup).not.toContain("Work detail");
  });

  it("mounts the existing Library screens at the /library route", () => {
    const markup = renderAt("/library");

    expect(markup).toContain(">Library<");
    expect(markup).toContain("Work detail");
  });

  it("links Library to the all-notes review surface (#390)", () => {
    const markup = renderAt("/library");

    expect(markup).toContain('href="#/notes"');
    expect(markup).toContain("Review all notes");
  });

  it("recedes the primary navigation and shows the reader landmark at the reader route", () => {
    const markup = renderAt("/reader");

    expect(markup).toContain('aria-label="Reader"');
    expect(markup).not.toContain("Work detail");
    expect(markup).not.toContain('aria-label="Primary"');
    // The reading surface stays calm: no recall UI, no practice-nudge UI, and no Today chrome
    // live in the reader.
    expect(markup).not.toContain("Due to recall");
    expect(markup).not.toContain('aria-label="Practice nudge"');
    expect(markup).not.toContain("Practise now");
    expect(markup).not.toContain('id="today-heading"');
    expect(markup).not.toContain("Capture a thought");
  });

  it("resolves the recall route to the due-recall page (still reachable off-nav)", () => {
    const markup = renderAt("/recall");

    expect(markup).toContain("Due to recall");
  });

  it("resolves the diary route to the voice-diary page (still reachable off-nav)", () => {
    const markup = renderAt("/diary");

    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain("Opening your diary…");
  });

  it("resolves the progress route to the mastery map page (labelled Map in the nav)", () => {
    const markup = renderAt("/progress");

    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain('id="progress-heading"');
  });

  it("resolves the reader route with a work query param to the reader page", () => {
    const markup = renderAt("/reader?work=work-1");

    expect(markup).toContain('aria-label="Reader"');
  });

  it("resolves the notes route to the cross-work notes page", () => {
    const markup = renderAt("/notes");

    expect(markup).toContain("Every note you have saved");
  });

  it("resolves the search route to the library search page", () => {
    const markup = renderAt("/search");

    expect(markup).toContain('role="search"');
    expect(markup).toContain("Find words and phrases across every work");
  });
});
