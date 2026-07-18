// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
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
// contains — the route content (e.g. Today's note-review card) shares those words, so the
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
  // Unmount the live-rendered roots (not merely wipe the DOM): the reader/write routes mount pages
  // that start async work, so leaving the root mounted let that work resolve after the jsdom
  // environment was torn down — a leaked React update that surfaced as `ReferenceError: window is
  // not defined` in CI. `cleanup()` unmounts every rendered tree, matching the repo convention.
  cleanup();
});

describe("App shell and routes", () => {
  it("shows exactly the five primary destinations in order in the nav (#638)", () => {
    const { getByRole } = renderLiveAt("/");
    const nav = getByRole("navigation", { name: "Primary" });

    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels).toEqual(["Today", "Library", "Recite", "Notes", "Diary"]);
  });

  it("keeps Reader, Review, and Search out of the primary nav (#638)", () => {
    const { getByRole } = renderLiveAt("/");
    const nav = getByRole("navigation", { name: "Primary" });

    for (const secondary of ["Reader", "Review", "Search"]) {
      expect(within(nav).queryByRole("link", { name: secondary })).toBeNull();
    }
  });

  it("keeps Search reachable in one action as a shell utility with the accessible name Search (#638)", () => {
    const markup = renderAt("/");

    expect(markup).toContain('href="/search"');
    expect(markup).toContain(">Search<");
  });

  it("marks Recite active on the secondary Recitation review route (#638)", () => {
    const { getByRole } = renderLiveAt("/recitation");
    const nav = getByRole("navigation", { name: "Primary" });

    expect(within(nav).getByRole("link", { name: "Recite" }).getAttribute("aria-current")).toBe(
      "page"
    );
    expect(
      within(nav).getByRole("link", { name: "Today" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("marks Notes active on the secondary note Review route (#638)", () => {
    const { getByRole } = renderLiveAt("/notes/review");
    const nav = getByRole("navigation", { name: "Primary" });

    expect(within(nav).getByRole("link", { name: "Notes" }).getAttribute("aria-current")).toBe(
      "page"
    );
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
    expect(markup).toContain("Capture today");
    // Today is the landing now — the Library no longer mounts at the index route.
    expect(markup).not.toContain("Work detail");
  });

  it("mounts the shelf-first Library at the /library route", () => {
    const markup = renderAt("/library");

    expect(markup).toContain(">Library<");
    // Raw content management now lives behind an on-demand "Manage content" sheet, so the shelf
    // route no longer renders the old always-visible "Work detail" panel (#392).
    expect(markup).not.toContain("Work detail");
  });

  it("links Library to the all-notes review surface (#390)", () => {
    const markup = renderAt("/library");

    expect(markup).toContain('href="#/notes"');
    expect(markup).toContain("Review all notes");
  });

  it("frames the reader within the shell with Library active and Search reachable, while staying calm (#638)", () => {
    const { getByRole, container } = renderLiveAt("/reader");
    const nav = getByRole("navigation", { name: "Primary" });

    // The reader is a secondary surface under Library: the primary nav is present and Library is the
    // active parent, and the Search utility stays one action away.
    expect(within(nav).getByRole("link", { name: "Library" }).getAttribute("aria-current")).toBe(
      "page"
    );
    expect(container.querySelector('a[href="/search"]')).not.toBeNull();

    // The reading landmark is present and the surface stays calm: no work-detail chrome, no recall or
    // practice-nudge UI, and no Today chrome live in the reader.
    const markup = container.innerHTML;
    expect(markup).toContain('aria-label="Reader"');
    expect(markup).not.toContain("Work detail");
    expect(markup).not.toContain("Due to recall");
    expect(markup).not.toContain('aria-label="Practice nudge"');
    expect(markup).not.toContain("Practise now");
    expect(markup).not.toContain('id="today-heading"');
    expect(markup).not.toContain("Capture today");
  });

  it("redirects the retired /memory route to the Notes home (#662)", () => {
    // Effects run under a live render, applying the <Navigate replace/> onto the Notes home.
    const { container } = renderLiveAt("/memory");

    expect(container.innerHTML).toContain('aria-label="Primary"');
    expect(container.innerHTML).toContain("Every note you have saved");
    // The retired standalone Memory surface never renders.
    expect(container.innerHTML).not.toContain('id="memory-heading"');
  });

  it("redirects the retired /recall route to the Notes-owned review session (#662)", () => {
    const { container } = renderLiveAt("/recall");

    expect(container.innerHTML).toContain('id="notes-review-heading"');
  });

  it("resolves the notes-review route to the Notes-owned review session", () => {
    const markup = renderAt("/notes/review");

    expect(markup).toContain('id="notes-review-heading"');
  });

  it("resolves the diary route to the voice-diary page as a primary destination (#638)", () => {
    const markup = renderAt("/diary");

    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain("Opening your diary…");
  });

  it("resolves a retired /practice navigation to the not-found page inside the shell", () => {
    const markup = renderAt("/practice");

    // The retired coach Practice route is gone: #/practice lands on the normal not-found route, never a
    // SessionPage. The shell (primary nav) still frames it, so it is a calm not-found, not a blank screen.
    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain('id="not-found-heading"');
    expect(markup).toContain("Page not found");
  });

  it("resolves the retired /progress route and any unknown path to the not-found page", () => {
    for (const path of ["/progress", "/does-not-exist"]) {
      const markup = renderAt(path);

      expect(markup).toContain('id="not-found-heading"');
      expect(markup).not.toContain('id="progress-heading"');
    }
  });

  it("resolves the reader route with a work query param to the reader page", () => {
    const markup = renderAt("/reader?work=work-1");

    expect(markup).toContain('aria-label="Reader"');
  });

  it("resolves the notes route to the cross-work notes page", () => {
    const markup = renderAt("/notes");

    expect(markup).toContain("Every note you have saved");
  });

  it("shows the empty write route when no work is selected", () => {
    const markup = renderAt("/write");

    expect(markup).toContain("No document selected");
  });

  it("frames the authored-work editor within the shell with Library active at the write route (#638)", () => {
    const { getByRole, container } = renderLiveAt("/write?work=work-1");
    const nav = getByRole("navigation", { name: "Primary" });

    // The editor mounts in its loading arm (effects do not run under static render), and the write route
    // is a secondary surface under Library: the primary nav is present with Library the active parent.
    expect(container.innerHTML).toContain("Opening your document…");
    expect(within(nav).getByRole("link", { name: "Library" }).getAttribute("aria-current")).toBe(
      "page"
    );
  });

  it("resolves the /recite route to the Recite home framed by the shell (#638)", () => {
    const markup = renderAt("/recite");

    // Recite is now a primary destination: its home mounts inside the shell (primary nav present) and,
    // under static render (no effects), in its loading arm. The retired passage-setup copy never renders.
    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain('id="recite-heading"');
    expect(markup).not.toContain("Loading passages…");
    expect(markup).not.toContain("Open a recitation routine from your Library to divide it.");
  });

  it("resolves the recitation route to the direct whole-Work review, framed by the shell (#643)", () => {
    const markup = renderAt("/recitation");

    // A secondary destination — reachable off-nav but still framed by the shell. Effects do not run
    // under static render, so the review page mounts in its loading arm.
    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain('id="recitation-heading"');
    expect(markup).toContain("Loading your recitation…");
    // The retired hub/passage surface is gone.
    expect(markup).not.toContain('id="recitation-hub-heading"');
  });

  it("resolves the recitation route with a work query param to that Work's review (#643)", () => {
    // The contextual `?work=` entry resolves to the review page; the route forwards the Work so the page
    // opens that exact Work's whole-Work review rather than the earliest-due one.
    const markup = renderAt("/recitation?work=work-1");

    expect(markup).toContain('id="recitation-heading"');
    expect(markup).toContain("Loading your recitation…");
  });

  it("resolves the search route to the library search page", () => {
    const markup = renderAt("/search");

    expect(markup).toContain('role="search"');
    expect(markup).toContain("Find words and phrases across every work");
  });
});
