// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

  it("gives the close control a >=44px hit target in both dimensions (#479)", () => {
    mockMatchMedia({});
    render(
      <Sheet onOpenChange={vi.fn()} open title="Note">
        <p>panel body</p>
      </Sheet>
    );

    // jsdom has no layout, so assert the sizing utilities (min-h-11 = min-w-11 = 44px).
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("min-h-11");
    expect(close.className).toContain("min-w-11");
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

  it("restores focus to the opener when it closes, even when unmounted while open (#469)", async () => {
    mockMatchMedia({});
    const user = userEvent.setup();

    // Mirrors the Library pattern: the sheet is rendered only while open, so closing UNMOUNTS it while
    // still open. Focus must return to the opener, not fall to <body>.
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Open
          </button>
          {open ? (
            <Sheet onOpenChange={() => setOpen(false)} open title="Note">
              <p>panel body</p>
            </Sheet>
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    await screen.findByRole("dialog", { name: "Note" });

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  });
});
