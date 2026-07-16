// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import type { NoteActivation } from "./noteActivation";
import { useNoteHighlights } from "./useNoteHighlights";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function note(overrides: Partial<AnchoredNoteDto> = {}): AnchoredNoteDto {
  return {
    anchor: {
      blockEntryId: toEntryId("b1"),
      contextSnapshot: "First block text.",
      endBlockEntryId: toEntryId("b1"),
      endOffset: 11,
      selectedTextSnapshot: "block",
      startOffset: 6
    },
    blockEntryId: toEntryId("b1"),
    bodyDoc: createTextDocument("a note"),
    bodyText: "a note",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("n1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  };
}

function Reader({
  notes,
  onActivate,
  renderKey = "k1",
  stray = false
}: {
  notes: ReadonlyArray<AnchoredNoteDto>;
  onActivate: (activation: NoteActivation) => void;
  renderKey?: string;
  stray?: boolean;
}): React.JSX.Element {
  useNoteHighlights(notes, renderKey, onActivate);

  return (
    <div className="reader">
      <div data-block-id="b1">First block text.</div>
      {stray ? (
        <span className="noteMark" data-note-id="ghost">
          ghost
        </span>
      ) : null}
    </div>
  );
}

function Bare({
  onActivate
}: {
  onActivate: (activation: NoteActivation) => void;
}): React.JSX.Element {
  useNoteHighlights([], "k1", onActivate);

  return <div>no reader here</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useNoteHighlights", () => {
  it("wraps the anchored text in an interactive underline naming the note it opens", async () => {
    const { container } = render(<Reader notes={[note()]} onActivate={vi.fn()} />);
    await flush();

    const mark = container.querySelector(".noteMark") as HTMLElement;
    expect(mark.textContent).toBe("block");
    expect(mark.getAttribute("data-note-id")).toBe("n1");
    expect(mark.getAttribute("role")).toBe("button");
    expect(mark.getAttribute("tabindex")).toBe("0");
    expect(mark.getAttribute("aria-label")).toBe("Open note on 'block'");
  });

  it("opens that exact note when its underline is clicked", async () => {
    const onActivate = vi.fn();
    const { container } = render(<Reader notes={[note()]} onActivate={onActivate} />);
    await flush();

    fireEvent.click(container.querySelector(".noteMark") as HTMLElement);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith({
      kind: "note",
      note: expect.objectContaining({ entryId: "n1" })
    });
  });

  it("opens the note from the keyboard (Enter activates the underline)", async () => {
    const onActivate = vi.fn();
    const { container } = render(<Reader notes={[note()]} onActivate={onActivate} />);
    await flush();

    fireEvent.keyDown(container.querySelector(".noteMark") as HTMLElement, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledWith({
      kind: "note",
      note: expect.objectContaining({ entryId: "n1" })
    });
  });

  it("opens the compact chooser directly for a bodyless mark", async () => {
    const onActivate = vi.fn();
    const { container } = render(
      <Reader
        notes={[note({ bodyDoc: null, bodyText: null, entryId: toEntryId("m1"), kind: "mark" })]}
        onActivate={onActivate}
      />
    );
    await flush();

    fireEvent.click(container.querySelector(".noteMark") as HTMLElement);

    expect(onActivate).toHaveBeenCalledWith({
      kind: "chooser",
      notes: [expect.objectContaining({ entryId: "m1", kind: "mark" })]
    });
  });

  it("does not open anything when an activated underline's note is no longer loaded", async () => {
    const onActivate = vi.fn();
    const { container } = render(<Reader notes={[note()]} onActivate={onActivate} stray />);
    await flush();

    const ghost = container.querySelector('.noteMark[data-note-id="ghost"]') as HTMLElement;
    fireEvent.click(ghost);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("uses the latest handler identity without re-applying the highlights", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const notes = [note()];
    const { container, rerender } = render(<Reader notes={notes} onActivate={first} />);
    await flush();
    const mark = container.querySelector(".noteMark") as HTMLElement;

    rerender(<Reader notes={notes} onActivate={second} />);
    await flush();

    // The same span is still in place (a new handler identity must not unwrap/rewrap the highlight).
    expect(container.querySelector(".noteMark")).toBe(mark);

    fireEvent.click(mark);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is no reader container to decorate", async () => {
    expect(() => render(<Bare onActivate={vi.fn()} />)).not.toThrow();
    await flush();

    expect(document.querySelector(".noteMark")).toBeNull();
  });

  it("removes the highlights it applied when the effect is torn down", async () => {
    const { container, unmount } = render(<Reader notes={[note()]} onActivate={vi.fn()} />);
    await flush();
    expect(container.querySelector(".noteMark")).not.toBeNull();

    unmount();

    expect(document.querySelector(".noteMark")).toBeNull();
  });
});
