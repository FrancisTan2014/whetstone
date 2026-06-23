// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sheet } from "./Sheet";

function mockMatchMedia(matchers: Record<string, boolean>): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    matches: matchers[query] ?? false,
    media: query,
    removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
});

describe("Sheet", () => {
  it("renders a right-docked side panel when the side is forced to right", () => {
    mockMatchMedia({});
    render(
      <Sheet onOpenChange={vi.fn()} open side="right" title="Note">
        <p>panel body</p>
      </Sheet>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-side")).toBe("right");
    expect(dialog.className).toContain("sheet-panel-right");
    expect(screen.getByText("panel body")).toBeDefined();
  });

  it("renders a bottom sheet when the side is forced to bottom", () => {
    mockMatchMedia({});
    render(
      <Sheet onOpenChange={vi.fn()} open side="bottom" title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByRole("dialog").getAttribute("data-side")).toBe("bottom");
  });

  it("defaults to a side panel on desktop widths", () => {
    mockMatchMedia({ "(min-width: 768px)": true });
    render(
      <Sheet onOpenChange={vi.fn()} open title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByRole("dialog").getAttribute("data-side")).toBe("right");
  });

  it("defaults to a bottom sheet on mobile widths", () => {
    mockMatchMedia({ "(min-width: 768px)": false });
    render(
      <Sheet onOpenChange={vi.fn()} open title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByRole("dialog").getAttribute("data-side")).toBe("bottom");
  });

  it("is dismissible via its close control", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    mockMatchMedia({});
    render(
      <Sheet onOpenChange={onOpenChange} open title="Note">
        <p>panel body</p>
      </Sheet>
    );

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("still renders its content under a reduced-motion preference", () => {
    mockMatchMedia({ "(prefers-reduced-motion: reduce)": true });
    render(
      <Sheet onOpenChange={vi.fn()} open side="bottom" title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByText("panel body")).toBeDefined();
  });
});
