// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Spinner } from "./Spinner";

afterEach(() => {
  cleanup();
});

describe("Spinner", () => {
  it("is decorative by default and stops under reduced motion", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("animate-spin");
    expect(svg?.getAttribute("class")).toContain("motion-reduce:animate-none");
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
