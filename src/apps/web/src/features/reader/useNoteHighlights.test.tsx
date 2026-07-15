// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { useNoteHighlights } from "./useNoteHighlights";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function note(): AnchoredNoteDto {
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
    updatedAt: "2024-01-01T00:00:00.000Z"
  };
}

function Reader({
  notes,
  renderKey = "k1"
}: {
  notes: ReadonlyArray<AnchoredNoteDto>;
  renderKey?: string;
}): React.JSX.Element {
  useNoteHighlights(notes, renderKey);

  return (
    <div className="reader">
      <div data-block-id="b1">First block text.</div>
    </div>
  );
}

function Bare(): React.JSX.Element {
  useNoteHighlights([], "k1");

  return <div>no reader here</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useNoteHighlights", () => {
  it("applies an inert decoration span carrying the note id but no interactive attributes (#555)", async () => {
    const { container } = render(<Reader notes={[note()]} />);
    await flush();

    const mark = container.querySelector(".noteMark") as HTMLElement;
    expect(mark.textContent).toBe("block");
    expect(mark.getAttribute("data-note-id")).toBe("n1");
    expect(mark.getAttribute("role")).toBeNull();
    expect(mark.getAttribute("tabindex")).toBeNull();
    expect(mark.getAttribute("aria-label")).toBeNull();
  });

  it("does nothing when there is no reader container to decorate", async () => {
    expect(() => render(<Bare />)).not.toThrow();
    await flush();

    expect(document.querySelector(".noteMark")).toBeNull();
  });

  it("removes the highlights it applied when the effect is torn down", async () => {
    const { container, unmount } = render(<Reader notes={[note()]} />);
    await flush();
    expect(container.querySelector(".noteMark")).not.toBeNull();

    // Tearing down the effect runs its cleanup, which unwraps every span it injected.
    unmount();

    expect(document.querySelector(".noteMark")).toBeNull();
  });
});
