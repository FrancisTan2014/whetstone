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
// contains — the route content (e.g. Today's "Recall" card) shares those words, so the
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
  it("shows exactly the four primary destinations in the nav (#573)", () => {
    const { getByRole } = renderLiveAt("/");
    const nav = getByRole("navigation", { name: "Primary" });

    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels).toEqual(["Today", "Library", "Memory", "Search"]);
  });

  it("keeps Reader, Recall, Notes, and Diary out of the primary nav (#573)", () => {
    const { getByRole } = renderLiveAt("/");
    const nav = getByRole("navigation", { name: "Primary" });

    for (const secondary of ["Reader", "Recall", "Notes", "Diary"]) {
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
    expect(markup).not.toContain("Capture today");
  });

  it("resolves the memory route to the Memory surface", () => {
    const markup = renderAt("/memory");

    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain('id="memory-heading"');
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

  it("opens the immersive authored-work editor at the write route with a work param", () => {
    const markup = renderAt("/write?work=work-1");

    // The editor mounts in its loading arm (effects do not run under static render), and the write
    // route is immersive like the reader — the primary nav recedes.
    expect(markup).toContain("Opening your document…");
    expect(markup).not.toContain('aria-label="Primary"');
  });

  it("redirects the retired /recite passage-setup route to the Library recovery path (#643)", () => {
    // The passage-segmentation route is retired: it must never open a dead or misleading screen, so it
    // redirects to the Library (effects run under a live render, applying the <Navigate/>).
    const { container } = renderLiveAt("/recite");

    expect(container.innerHTML).toContain(">Library<");
    // None of the retired segmentation copy survives on the recovery landing.
    expect(container.innerHTML).not.toContain("Loading passages…");
    expect(container.innerHTML).not.toContain("Open a recitation routine from your Library to divide it.");
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
