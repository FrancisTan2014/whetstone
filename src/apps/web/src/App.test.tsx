// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

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

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("App shell and routes", () => {
  it("renders the primary navigation with every mode in the shell", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-label="Primary"');
    for (const label of ["Library", "Reader", "Recall", "Notes", "Search"]) {
      expect(markup).toContain(label);
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

  it("mounts the existing Library screens at the index route", () => {
    const markup = renderAt("/");

    expect(markup).toContain(">Library<");
    expect(markup).toContain("Work detail");
  });

  it("recedes the primary navigation and shows the reader landmark at the reader route", () => {
    const markup = renderAt("/reader");

    expect(markup).toContain('aria-label="Reader"');
    expect(markup).not.toContain("Work detail");
    expect(markup).not.toContain('aria-label="Primary"');
    // The reading surface stays calm: no recall UI lives in the reader.
    expect(markup).not.toContain("Due to recall");
  });

  it("resolves the recall route to the due-recall page", () => {
    const markup = renderAt("/recall");

    expect(markup).toContain("Due to recall");
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
