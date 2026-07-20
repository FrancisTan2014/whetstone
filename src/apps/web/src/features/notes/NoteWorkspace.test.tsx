// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTextDocument } from "@whetstone/document";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The rich editor is exercised in its own suite; here it stands in as a textarea (plus an explicit
// keyboard-save trigger) so the workspace's dirty/save behaviour is asserted without driving Tiptap.
vi.mock("../../shared/editor/index.js", async () => {
  const { createTextDocument: make, documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange,
      onSave
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
      onSave?: () => void;
    }) =>
      React.createElement("div", null, [
        React.createElement("textarea", {
          "aria-label": ariaLabel,
          defaultValue: documentText(document as never),
          key: "ta",
          onChange: (event: { target: { value: string } }) => onChange(make(event.target.value))
        }),
        React.createElement(
          "button",
          { key: "sv", onClick: () => onSave?.(), type: "button" },
          "editor-save-shortcut"
        )
      ])
  };
});

// CardsView has its own suite; stub it so the workspace's Note|Cards gating and mounting is asserted here.
vi.mock("./CardsView", async () => {
  const React = await import("react");
  return {
    CardsView: (props: {
      noteEntryId: string;
      onReviewChanged: () => void;
      sourceSnapshot: string | null;
    }) =>
      React.createElement("div", null, [
        React.createElement("span", { key: "id" }, `cards-view:${props.noteEntryId}`),
        React.createElement("span", { key: "src" }, `cards-source:${String(props.sourceSnapshot)}`),
        React.createElement(
          "button",
          { key: "rc", onClick: () => props.onReviewChanged(), type: "button" },
          "stub-review-changed"
        )
      ])
  };
});

import { NoteWorkspace } from "./NoteWorkspace";

type WorkspaceProps = Parameters<typeof NoteWorkspace>[0];
import {
  type NoteWorkspaceHandle,
  type NoteWorkspaceOps,
  type NoteWorkspaceTarget
} from "./noteWorkspaceModel";

function handle(overrides: Partial<NoteWorkspaceHandle> = {}): NoteWorkspaceHandle {
  return {
    bodyDoc: createTextDocument("saved body"),
    entryId: "note-1",
    source: { blockEntryId: "block-1", snapshot: "the source", workEntryId: "work-1" },
    ...overrides
  };
}

function makeOps(overrides: Partial<NoteWorkspaceOps> = {}): {
  ops: NoteWorkspaceOps;
  remove: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
} {
  const save = vi.fn(async () => handle());
  const remove = vi.fn(async () => undefined);
  return { ops: { remove, save, ...overrides }, remove, save };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const createTarget: NoteWorkspaceTarget = {
  kind: "create",
  source: { blockEntryId: "block-1", snapshot: "the source", workEntryId: "work-1" }
};
const editTarget: NoteWorkspaceTarget = { kind: "edit", note: handle() };

function renderWorkspace(
  overrides: {
    onClose?: WorkspaceProps["onClose"];
    onDeleted?: WorkspaceProps["onDeleted"];
    onReviewChanged?: WorkspaceProps["onReviewChanged"];
    onSaved?: WorkspaceProps["onSaved"];
    ops?: NoteWorkspaceOps;
    target?: NoteWorkspaceTarget;
  } = {}
) {
  const onClose = overrides.onClose ?? vi.fn<() => void>();
  // Compose props with conditional spreads: with exactOptionalPropertyTypes, an optional callback prop may be
  // omitted but not passed an explicit `undefined`, so only include a key when the override is provided.
  const props: WorkspaceProps = {
    onClose,
    ops: overrides.ops ?? makeOps().ops,
    target: overrides.target ?? createTarget,
    ...(overrides.onDeleted !== undefined ? { onDeleted: overrides.onDeleted } : {}),
    ...(overrides.onReviewChanged !== undefined
      ? { onReviewChanged: overrides.onReviewChanged }
      : {}),
    ...(overrides.onSaved !== undefined ? { onSaved: overrides.onSaved } : {})
  };
  render(<NoteWorkspace {...props} />);
  return { onClose };
}

beforeAll(() => {
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView"
  ]) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: () => false
    });
  }
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("NoteWorkspace create flow", () => {
  it("opens a fresh capture in Note only, with its source and no delete overflow", () => {
    renderWorkspace();
    expect(screen.getByRole("heading", { name: "New note" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Note" })).toBeDefined();
    expect(screen.queryByRole("tab", { name: "Cards" })).toBeNull();
    expect(screen.getByText(/Source:.*the source/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Note actions" })).toBeNull();
    // Nothing to save yet.
    expect(screen.getByRole("button", { name: "Save note" })).toHaveProperty("disabled", true);
  });

  it("persists the first save, transitions create->edit, and reveals Cards", async () => {
    const { ops, save } = makeOps();
    const onSaved = vi.fn<NonNullable<WorkspaceProps["onSaved"]>>();
    renderWorkspace({ onSaved, ops });

    await userEvent.type(screen.getByLabelText("Note body"), "a captured note");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(createTextDocument("a captured note"), null)
    );
    expect(await screen.findByRole("heading", { name: "Edit note" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Cards" })).toBeDefined();
    expect(onSaved).toHaveBeenCalledWith(handle());
  });

  it("threads the persisted note as `current` on the second save", async () => {
    const { ops, save } = makeOps();
    renderWorkspace({ ops });

    await userEvent.type(screen.getByLabelText("Note body"), "first");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    await screen.findByRole("heading", { name: "Edit note" });

    await userEvent.type(screen.getByLabelText("Note body"), " second");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    // The first save creates (current === null); the second updates the now-persisted note.
    expect(save.mock.calls[0]?.[1]).toBeNull();
    expect(save.mock.calls[1]?.[1]).toEqual(handle());
  });

  it("saves without an onSaved handler", async () => {
    renderWorkspace();
    await userEvent.type(screen.getByLabelText("Note body"), "a note");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("heading", { name: "Edit note" })).toBeDefined();
  });

  it("guards a blank save triggered by the editor shortcut", async () => {
    renderWorkspace();
    await userEvent.click(screen.getByRole("button", { name: "editor-save-shortcut" }));
    expect(await screen.findByText("Write something before saving the note.")).toBeDefined();
  });

  it("reports a failed save and stays a new note", async () => {
    const save = vi.fn().mockRejectedValue(new Error("offline"));
    renderWorkspace({ ops: { remove: vi.fn(), save } });

    await userEvent.type(screen.getByLabelText("Note body"), "a note");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Could not save the note. Please try again.")).toBeDefined();
    expect(screen.getByRole("heading", { name: "New note" })).toBeDefined();
  });
});

describe("NoteWorkspace Note|Cards gating", () => {
  it("opens Cards for a clean persisted note and forwards review changes", async () => {
    const onReviewChanged = vi.fn<NonNullable<WorkspaceProps["onReviewChanged"]>>();
    renderWorkspace({ onReviewChanged, target: editTarget });

    await userEvent.click(screen.getByRole("tab", { name: "Cards" }));
    expect(await screen.findByText("cards-view:note-1")).toBeDefined();
    // An anchored note forwards its source snapshot so Cards enrollment can reuse it.
    expect(screen.getByText("cards-source:the source")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "stub-review-changed" }));
    expect(onReviewChanged).toHaveBeenCalled();
  });

  it("passes no source snapshot when a standalone note opens Cards", async () => {
    const standalone: NoteWorkspaceTarget = { kind: "edit", note: handle({ source: null }) };
    renderWorkspace({ target: standalone });

    await userEvent.click(screen.getByRole("tab", { name: "Cards" }));
    // A standalone note has no source, so enrollment gets a null snapshot.
    expect(await screen.findByText("cards-source:null")).toBeDefined();
  });

  it("returns to Note from Cards, keeping the mounted Cards panel hidden", async () => {
    renderWorkspace({ target: editTarget });

    await userEvent.click(screen.getByRole("tab", { name: "Cards" }));
    expect(await screen.findByText("cards-view:note-1")).toBeDefined();

    await userEvent.click(screen.getByRole("tab", { name: "Note" }));
    // Back in Note: its editor is shown again and reports the active tab.
    expect(screen.getByLabelText("Note body")).toBeDefined();
    expect(screen.getByRole("tab", { name: "Note" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens Cards without an onReviewChanged handler", async () => {
    renderWorkspace({ target: editTarget });
    await userEvent.click(screen.getByRole("tab", { name: "Cards" }));
    await userEvent.click(await screen.findByRole("button", { name: "stub-review-changed" }));
    // No throw: the optional notification is simply skipped.
    expect(screen.getByText("cards-view:note-1")).toBeDefined();
  });

  it("blocks Cards while the note is dirty, announcing why and focusing Save", async () => {
    renderWorkspace({ target: editTarget });

    await userEvent.type(screen.getByLabelText("Note body"), " edited");
    await userEvent.click(screen.getByRole("tab", { name: "Cards" }));

    expect(screen.getByText("Save note changes before managing cards.")).toBeDefined();
    expect(screen.queryByText("cards-view:note-1")).toBeNull();
    expect((document.activeElement as HTMLElement).textContent).toBe("Save note");
  });

  it("does not fetch Cards until the tab is first opened", () => {
    renderWorkspace({ target: editTarget });
    // A persisted note shows the Cards tab but keeps the panel unmounted until activated.
    expect(screen.queryByText("cards-view:note-1")).toBeNull();
  });

  it("ignores re-activating the tab that is already active", async () => {
    renderWorkspace({ target: editTarget });
    await userEvent.click(screen.getByRole("tab", { name: "Note" }));
    expect(screen.getByLabelText("Note body")).toBeDefined();
  });
});

describe("NoteWorkspace delete", () => {
  async function openDelete(): Promise<void> {
    await userEvent.click(screen.getByRole("button", { name: "Note actions" }));
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete note" }));
  }

  it("confirms a delete, naming the source, and runs the cascade", async () => {
    const { ops, remove } = makeOps();
    const onDeleted = vi.fn<NonNullable<WorkspaceProps["onDeleted"]>>();
    renderWorkspace({ onDeleted, ops, target: editTarget });

    await openDelete();
    expect(screen.getByText(/Delete this note/)).toBeDefined();
    expect(screen.getByText(/the source/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("note-1"));
    expect(onDeleted).toHaveBeenCalledWith("note-1");
  });

  it("deletes without an onDeleted handler", async () => {
    const { ops, remove } = makeOps();
    renderWorkspace({ ops, target: editTarget });
    await openDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("note-1"));
  });

  it("cancels a delete and restores focus to the overflow trigger", async () => {
    renderWorkspace({ target: editTarget });
    await openDelete();
    await userEvent.click(screen.getByRole("button", { name: "Keep note" }));

    expect(screen.queryByText(/Delete this note/)).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Note actions");
  });

  it("reports a failed delete and keeps the confirmation open", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("offline"));
    renderWorkspace({ ops: { remove, save: vi.fn() }, target: editTarget });

    await openDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));

    expect(await screen.findByText("Could not delete the note. Please try again.")).toBeDefined();
  });

  it("names no source when deleting a standalone note", async () => {
    const standalone: NoteWorkspaceTarget = {
      kind: "edit",
      note: handle({ source: null })
    };
    renderWorkspace({ target: standalone });
    // A standalone note shows no source disclosure.
    expect(screen.queryByText(/Source:/)).toBeNull();

    await openDelete();
    expect(screen.getByText("Delete this note? This cannot be undone.")).toBeDefined();
  });
});

describe("NoteWorkspace dismissal", () => {
  it("closes on the Cancel control", async () => {
    const { onClose } = renderWorkspace();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the Sheet Close control", async () => {
    const { onClose } = renderWorkspace();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("blocks dismissal while a save is in flight", async () => {
    const pending = deferred<NoteWorkspaceHandle>();
    const save = vi.fn(() => pending.promise);
    const { onClose } = renderWorkspace({ ops: { remove: vi.fn(), save } });

    await userEvent.type(screen.getByLabelText("Note body"), "a note");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    // Mid-write: Escape/Close must not abandon the save.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();

    pending.resolve(handle());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Edit note" })).toBeDefined());
  });
});
