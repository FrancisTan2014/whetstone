// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NotesOverflowMenu } from "./NotesOverflowMenu";

beforeAll(() => {
  // Radix DropdownMenu reads pointer-capture and layout APIs jsdom lacks; stub them so opening the menu
  // during interaction tests does not throw.
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {}
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {}
  });
});

afterEach(() => {
  cleanup();
});

describe("NotesOverflowMenu", () => {
  it("opens from an accessibly named 44px trigger and runs Import on select", async () => {
    const onImport = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(<NotesOverflowMenu busy={false} onImport={onImport} triggerRef={triggerRef} />);

    const trigger = screen.getByRole("button", { name: "More note actions" });
    // The icon-only trigger keeps a hover tooltip and the shared 44px icon target (#641).
    expect(trigger.getAttribute("title")).toBe("More note actions");
    expect(trigger.className).toContain("min-w-11");
    // The page manages focus via the trigger element, so the ref must resolve to it.
    expect(triggerRef.current).toBe(trigger);

    await userEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "More note actions" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Import" }));

    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("disables the trigger while an import is running so a second import cannot start", () => {
    render(
      <NotesOverflowMenu busy onImport={vi.fn()} triggerRef={createRef<HTMLButtonElement>()} />
    );

    expect(screen.getByRole("button", { name: "More note actions" })).toHaveProperty(
      "disabled",
      true
    );
  });
});
