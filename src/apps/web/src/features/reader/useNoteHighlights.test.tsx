// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NoteDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { useNoteHighlights } from "./useNoteHighlights";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function note(): NoteDto {
  return {
    answers: {},
    anchor: {
      blockEntryId: toEntryId("b1"),
      contextSnapshot: "First block text.",
      endBlockEntryId: toEntryId("b1"),
      endOffset: 11,
      selectedTextSnapshot: "block",
      startOffset: 6
    },
    blockEntryId: toEntryId("b1"),
    entryId: toEntryId("n1"),
    markdown: "",
    templateId: "vocabulary"
  };
}

function Reader({
  notes,
  onActivate,
  renderKey = "k1"
}: {
  notes: ReadonlyArray<NoteDto>;
  onActivate: (noteId: string) => void;
  renderKey?: string;
}): React.JSX.Element {
  useNoteHighlights(notes, onActivate, renderKey);

  return (
    <div className="reader">
      <div data-block-id="b1">First block text.</div>
    </div>
  );
}

function Bare({ onActivate }: { onActivate: (noteId: string) => void }): React.JSX.Element {
  useNoteHighlights([], onActivate, "k1");

  return <div>no reader here</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useNoteHighlights", () => {
  it("applies the highlights and opens a note when its highlight is clicked", async () => {
    const onActivate = vi.fn();
    const { container } = render(<Reader notes={[note()]} onActivate={onActivate} />);
    await flush();

    const mark = container.querySelector(".noteMark") as HTMLElement;
    expect(mark.textContent).toBe("block");

    act(() => {
      mark.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onActivate).toHaveBeenCalledWith("n1");
  });

  it("opens a note on Enter and prevents the default key action", async () => {
    const onActivate = vi.fn();
    const { container } = render(<Reader notes={[note()]} onActivate={onActivate} />);
    await flush();

    const mark = container.querySelector(".noteMark") as HTMLElement;
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });

    act(() => {
      mark.dispatchEvent(event);
    });

    expect(onActivate).toHaveBeenCalledWith("n1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores a non-Enter key on a highlight", async () => {
    const onActivate = vi.fn();
    const { container } = render(<Reader notes={[note()]} onActivate={onActivate} />);
    await flush();

    const mark = container.querySelector(".noteMark") as HTMLElement;

    act(() => {
      mark.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("ignores a click that is not on a highlight", async () => {
    const onActivate = vi.fn();
    render(<Reader notes={[note()]} onActivate={onActivate} />);
    await flush();

    act(() => {
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("does nothing when there is no reader container to decorate", async () => {
    const onActivate = vi.fn();
    expect(() => render(<Bare onActivate={onActivate} />)).not.toThrow();
    await flush();

    expect(document.querySelector(".noteMark")).toBeNull();
  });

  it("removes a highlight resolved after the effect was torn down", async () => {
    const onActivate = vi.fn();
    const { unmount } = render(<Reader notes={[note()]} onActivate={onActivate} />);

    // Tear down before the async apply resolves, so the resolved cleanup runs against a cancelled
    // effect and removes the spans it would otherwise have left behind.
    unmount();
    await flush();

    expect(document.querySelector(".noteMark")).toBeNull();
  });
});
