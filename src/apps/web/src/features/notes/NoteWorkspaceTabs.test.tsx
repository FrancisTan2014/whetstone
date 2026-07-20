// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoteWorkspaceTabs, type WorkspaceTab } from "./NoteWorkspaceTabs";

const tabs: ReadonlyArray<WorkspaceTab> = [
  { controls: "note-panel", id: "note", label: "Note" },
  { controls: "cards-panel", id: "cards", label: "Cards" }
];

function renderTabs(activeId = "note"): { onActivate: ReturnType<typeof vi.fn> } {
  const onActivate = vi.fn();
  render(
    <NoteWorkspaceTabs activeId={activeId} label="Note workspace" onActivate={onActivate} tabs={tabs} />
  );
  return { onActivate };
}

afterEach(() => cleanup());

describe("NoteWorkspaceTabs", () => {
  it("renders a labelled tablist with the active tab as the only tab stop", () => {
    renderTabs("note");
    const list = screen.getByRole("tablist", { name: "Note workspace" });
    const note = screen.getByRole("tab", { name: "Note" });
    const cards = screen.getByRole("tab", { name: "Cards" });

    expect(list).toBeDefined();
    expect(note.getAttribute("aria-selected")).toBe("true");
    expect(note.getAttribute("aria-controls")).toBe("note-panel");
    expect(note.id).toBe("note-tab");
    expect(note.tabIndex).toBe(0);
    expect(cards.getAttribute("aria-selected")).toBe("false");
    expect(cards.tabIndex).toBe(-1);
  });

  it("reports the clicked tab's intent", async () => {
    const { onActivate } = renderTabs("note");
    await userEvent.click(screen.getByRole("tab", { name: "Cards" }));
    expect(onActivate).toHaveBeenCalledWith("cards");
  });

  it("auto-activates the next tab on ArrowRight/ArrowDown (wrapping)", () => {
    const { onActivate } = renderTabs("note");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Note" }), { key: "ArrowRight" });
    expect(onActivate).toHaveBeenLastCalledWith("cards");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Cards" }), { key: "ArrowDown" });
    // From the last tab, wrapping returns to the first.
    expect(onActivate).toHaveBeenLastCalledWith("note");
  });

  it("auto-activates the previous tab on ArrowLeft/ArrowUp (wrapping)", () => {
    const { onActivate } = renderTabs("note");
    // From the first tab, wrapping goes to the last.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Note" }), { key: "ArrowLeft" });
    expect(onActivate).toHaveBeenLastCalledWith("cards");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Cards" }), { key: "ArrowUp" });
    expect(onActivate).toHaveBeenLastCalledWith("note");
  });

  it("jumps to the first tab on Home and the last on End", () => {
    const { onActivate } = renderTabs("cards");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Cards" }), { key: "Home" });
    expect(onActivate).toHaveBeenLastCalledWith("note");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Note" }), { key: "End" });
    expect(onActivate).toHaveBeenLastCalledWith("cards");
  });

  it("ignores keys it does not handle", () => {
    const { onActivate } = renderTabs("note");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Note" }), { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
  });
});
