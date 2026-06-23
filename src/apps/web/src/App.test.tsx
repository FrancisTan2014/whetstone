import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { App } from "./App";

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("App shell and routes", () => {
  it("renders the primary navigation with every mode in the shell", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-label="Primary"');
    for (const label of ["Library", "Reader", "Notes", "Search"]) {
      expect(markup).toContain(label);
    }
  });

  it("marks the active destination at the index route", () => {
    const markup = renderAt("/");

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("text-accent");
    expect(markup).toContain("text-text-muted");
  });

  it("mounts the existing Library screens at the index route", () => {
    const markup = renderAt("/");

    expect(markup).toContain("Library admin");
    expect(markup).toContain('id="content-heading"');
  });

  it("resolves the reader route to the reader page", () => {
    const markup = renderAt("/reader");

    expect(markup).toContain('id="reader-heading"');
    expect(markup).not.toContain('id="content-heading"');
  });

  it("resolves the notes route to its placeholder region", () => {
    const markup = renderAt("/notes");

    expect(markup).toContain('id="notes-mode-heading"');
    expect(markup).toContain("later slice");
  });

  it("resolves the search route to its placeholder region", () => {
    const markup = renderAt("/search");

    expect(markup).toContain('id="search-mode-heading"');
    expect(markup).toContain("later slice");
  });
});
