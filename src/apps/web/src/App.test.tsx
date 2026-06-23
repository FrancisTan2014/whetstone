import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the library admin page", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Library admin");
    expect(markup).toContain("Loading the library");
    expect(markup).not.toContain("Foundation scaffold");
  });
});
