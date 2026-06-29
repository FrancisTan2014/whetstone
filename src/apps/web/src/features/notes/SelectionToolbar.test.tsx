// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SelectionToolbar } from "./SelectionToolbar";

function renderToolbar(
  overrides: {
    anchorRect?: DOMRect;
    disabledHint?: string;
    onClose?: () => void;
    onConfirm?: () => void;
    onLookup?: () => void;
    onMark?: () => void;
  } = {}
): {
  onClose: () => void;
  onConfirm: () => void;
  onLookup: () => void;
  onMark: () => void;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onClose = overrides.onClose ?? vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  const onLookup = overrides.onLookup ?? vi.fn();
  const onMark = overrides.onMark ?? vi.fn();
  const user = userEvent.setup();

  render(
    <SelectionToolbar
      anchorRect={overrides.anchorRect}
      disabledHint={overrides.disabledHint}
      onClose={onClose}
      onConfirm={onConfirm}
      onLookup={onLookup}
      onMark={onMark}
      prefersReducedMotion={false}
    />
  );

  return { onClose, onConfirm, onLookup, onMark, user };
}

afterEach(() => {
  cleanup();
});

describe("SelectionToolbar", () => {
  it("shows the primary actions (Add note, Mark, Look up) plus a dismiss control", () => {
    renderToolbar();

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Add note",
      "Mark",
      "Look up",
      "✕"
    ]);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("marks the selection without opening the editor or looking up", async () => {
    const { onConfirm, onLookup, onMark, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Mark" }));

    expect(onMark).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onLookup).not.toHaveBeenCalled();
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

  it("disables Add note and Mark with a hint when the selection overlaps an annotation, keeping Look up", async () => {
    const { onConfirm, onLookup, onMark, user } = renderToolbar({
      disabledHint: "Notes can't overlap"
    });

    const addNote = screen.getByRole("button", { name: "Add note" }) as HTMLButtonElement;
    expect(addNote.disabled).toBe(true);
    const mark = screen.getByRole("button", { name: "Mark" }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    expect(screen.getByText("Notes can't overlap")).toBeDefined();

    await user.click(addNote);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(mark);
    expect(onMark).not.toHaveBeenCalled();

    // Look up stays available even when the selection overlaps.
    const lookUp = screen.getByRole("button", { name: "Look up" }) as HTMLButtonElement;
    expect(lookUp.disabled).toBe(false);
    await user.click(lookUp);
    expect(onLookup).toHaveBeenCalled();
  });
});
