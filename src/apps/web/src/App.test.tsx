import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders a foundation placeholder without reader or admin features", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Foundation scaffold");
    expect(markup).toContain("whetstone foundation");
    expect(markup).toContain("/health");
    expect(markup).not.toContain("Create note");
    expect(markup).not.toContain("Admin material");
  });
});
