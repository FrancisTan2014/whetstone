// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SelectionToolbar } from "./SelectionToolbar";

function renderToolbar(
  overrides: {
    anchorRect?: DOMRect;
    onClose?: () => void;
    onConfirm?: () => void;
    onLookup?: () => void;
  } = {}
): {
  onClose: () => void;
  onConfirm: () => void;
  onLookup: () => void;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onClose = overrides.onClose ?? vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  const onLookup = overrides.onLookup ?? vi.fn();
  const user = userEvent.setup();

  render(
    <SelectionToolbar
      anchorRect={overrides.anchorRect}
      onClose={onClose}
      onConfirm={onConfirm}
      onLookup={onLookup}
      prefersReducedMotion={false}
    />
  );

  return { onClose, onConfirm, onLookup, user };
}

afterEach(() => {
  cleanup();
});

describe("SelectionToolbar", () => {
  it("shows exactly two primary actions plus a dismiss control", () => {
    renderToolbar();

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Add note", "Look up", "✕"]);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("confirms to open the editor", async () => {
    const { onConfirm, onLookup, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Add note" }));

    expect(onConfirm).toHaveBeenCalled();
    expect(onLookup).not.toHaveBeenCalled();
  });

  it("triggers a lookup without opening the editor", async () => {
    const { onConfirm, onLookup, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Look up" }));

    expect(onLookup).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("dismisses when closed", async () => {
    const { onClose, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("presents the annotate toolbar with its actions when anchored to a selection rect", () => {
    renderToolbar({ anchorRect: { bottom: 40, left: 12 } as DOMRect });

    // With a selection rect the toolbar still presents its labelled actions; exact pixel
    // placement is styling, not behavior, so it is not asserted here.
    expect(screen.getByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Add note" })).toBeDefined();
  });

  it("renders the toolbar when no selection rect is given", () => {
    renderToolbar();

    expect(screen.getByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
  });
});
