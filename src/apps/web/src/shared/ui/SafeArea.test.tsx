// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SafeArea } from "./SafeArea";

afterEach(() => {
  cleanup();
});

describe("SafeArea", () => {
  it("renders its children", () => {
    render(
      <SafeArea>
        <p>framed content</p>
      </SafeArea>
    );

    expect(screen.getByText("framed content")).toBeDefined();
  });
});
