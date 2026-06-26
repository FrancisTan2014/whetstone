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
    for (const label of ["Library", "Reader", "Notes", "Search"]) {
      expect(markup).toContain(label);
    }
  });

  it("gives the theme toggle a home in the shell", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-label="Switch to Night"');
    expect(markup).toContain("<svg");
  });

  it("mounts the single toast live region in the shell", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-label="Notifications"');
  });

  it("marks the active destination at the index route", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("text-accent");
    expect(markup).toContain("text-text-muted");
  });

  it("mounts the existing Library screens at the index route", () => {
    const markup = renderAt("/");

    expect(markup).toContain(">Library<");
    expect(markup).toContain('id="content-heading"');
  });

  it("recedes the primary navigation and shows the reader landmark at the reader route", () => {
    const markup = renderAt("/reader");

    expect(markup).toContain('aria-label="Reader"');
    expect(markup).not.toContain('id="content-heading"');
    expect(markup).not.toContain('aria-label="Primary"');
  });

  it("resolves the reader route with a work query param to the reader page", () => {
    const markup = renderAt("/reader?work=work-1");

    expect(markup).toContain('aria-label="Reader"');
  });

  it("resolves the notes route to the cross-work notes page", () => {
    const markup = renderAt("/notes");

    expect(markup).toContain('id="notes-heading"');
    expect(markup).toContain("Every note you have saved");
  });

  it("resolves the search route to the library search page", () => {
    const markup = renderAt("/search");

    expect(markup).toContain('id="search-heading"');
    expect(markup).toContain('role="search"');
    expect(markup).toContain('id="search-query"');
  });
});
