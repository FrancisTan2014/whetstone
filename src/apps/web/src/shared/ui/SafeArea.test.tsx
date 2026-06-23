// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SafeArea } from "./SafeArea";

afterEach(() => {
  cleanup();
});

describe("SafeArea", () => {
  it("renders its children inside the safe-area container", () => {
    render(
      <SafeArea>
        <p>framed content</p>
      </SafeArea>
    );

    const child = screen.getByText("framed content");
    expect(child).toBeDefined();
    expect(child.parentElement?.className).toContain("app-safe-area");
  });
});
