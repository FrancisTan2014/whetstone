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

  it("anchors to the selection rect when one is given", () => {
    renderToolbar({ anchorRect: { bottom: 40, left: 12 } as DOMRect });

    const toolbar = screen.getByRole("toolbar", { name: "Annotate selection" });
    expect(toolbar.style.left).toBe("12px");
    expect(toolbar.style.top).toBe("40px");
  });

  it("renders without a fixed position when no rect is given", () => {
    renderToolbar();

    const toolbar = screen.getByRole("toolbar", { name: "Annotate selection" });
    expect(toolbar.style.left).toBe("");
    expect(toolbar.style.top).toBe("");
  });
});
