// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Toast } from "./Toast";

afterEach(() => {
  cleanup();
});

describe("Toast", () => {
  it("announces its message politely", () => {
    render(<Toast message="Note saved." prefersReducedMotion={false} />);

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Note saved.");
  });

  it("still shows the message under reduced motion", () => {
    render(<Toast message="Note deleted." prefersReducedMotion />);

    expect(screen.getByRole("status").textContent).toBe("Note deleted.");
  });
});
