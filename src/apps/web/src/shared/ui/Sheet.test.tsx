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
  it("renders an accessible dialog labelled by its title, with its content", () => {
    mockMatchMedia({});
    render(
      <Sheet onOpenChange={vi.fn()} open side="right" title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByRole("dialog", { name: "Note" })).toBeDefined();
    expect(screen.getByText("panel body")).toBeDefined();
  });

  it("renders the dialog when docked as a bottom sheet", () => {
    mockMatchMedia({});
    render(
      <Sheet onOpenChange={vi.fn()} open side="bottom" title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByRole("dialog", { name: "Note" })).toBeDefined();
    expect(screen.getByText("panel body")).toBeDefined();
  });

  it("opens an accessible dialog at desktop widths", () => {
    mockMatchMedia({ "(min-width: 768px)": true });
    render(
      <Sheet onOpenChange={vi.fn()} open title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByRole("dialog", { name: "Note" })).toBeDefined();
  });

  it("opens an accessible dialog at mobile widths", () => {
    mockMatchMedia({ "(min-width: 768px)": false });
    render(
      <Sheet onOpenChange={vi.fn()} open title="Note">
        <p>panel body</p>
      </Sheet>
    );

    expect(screen.getByRole("dialog", { name: "Note" })).toBeDefined();
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
