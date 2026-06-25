// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Spinner } from "./Spinner";

afterEach(() => {
  cleanup();
});

describe("Spinner", () => {
  it("is decorative by default and stays perceivably active under reduced motion via a cross-fade", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("animate-spin");
    // The `loadingSpinner` hook plus the two arc hooks drive a reduced-motion-safe counter-phase
    // opacity cross-fade (see theme.css), so the indicator clearly conveys activity instead of
    // freezing into a static icon when rotation is disabled.
    expect(svg?.getAttribute("class")).toContain("loadingSpinner");
    expect(container.querySelector("circle")?.getAttribute("class")).toContain(
      "loadingSpinnerTrack"
    );
    expect(container.querySelector("path")?.getAttribute("class")).toContain("loadingSpinnerArc");
  });

  it("announces a label when used standalone", () => {
    render(<Spinner label="Loading" />);

    expect(screen.getByRole("img", { name: "Loading" })).toBeDefined();
  });

  it("appends caller-provided classes", () => {
    const { container } = render(<Spinner className="mr-2" />);

    expect(container.querySelector("svg")?.getAttribute("class")).toContain("mr-2");
  });
});
