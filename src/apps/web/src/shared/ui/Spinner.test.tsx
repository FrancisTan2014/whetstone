// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Spinner } from "./Spinner";

afterEach(() => {
  cleanup();
});

describe("Spinner", () => {
  it("is decorative — hidden from assistive tech — when used without a label", () => {
    render(<Spinner />);

    // A label-less spinner is a companion to visible text, so it exposes no accessible image.
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("announces its label as a standalone status image when given one", () => {
    render(<Spinner label="Loading" />);

    expect(screen.getByRole("img", { name: "Loading" })).toBeDefined();
  });

  it("keeps its semantics when a caller passes an extra className", () => {
    render(<Spinner className="mr-2" label="Saving" />);

    // The optional className is styling that passes through; the indicator stays announced.
    expect(screen.getByRole("img", { name: "Saving" })).toBeDefined();
  });
});
