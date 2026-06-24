// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LoadingIndicator } from "./LoadingIndicator";

afterEach(() => {
  cleanup();
});

describe("LoadingIndicator", () => {
  it("announces the default label as a busy status", () => {
    render(<LoadingIndicator />);

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toContain("Loading…");
  });

  it("shows a custom label", () => {
    render(<LoadingIndicator label="Loading works…" />);

    expect(screen.getByRole("status").textContent).toContain("Loading works…");
  });
});
