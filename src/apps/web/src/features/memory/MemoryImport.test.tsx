// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memoryApi", () => ({
  importMemory: vi.fn(),
  suggestGloss: vi.fn()
}));

import type { MemoryGlossSuggestionDto } from "@whetstone/contracts";

import { importMemory, suggestGloss } from "./memoryApi";
import { MemoryImport } from "./MemoryImport";

const mockedImport = vi.mocked(importMemory);
const mockedSuggest = vi.mocked(suggestGloss);

function suggestion(overrides: Partial<MemoryGlossSuggestionDto> = {}): MemoryGlossSuggestionDto {
  return { suggestion: "to reveal a secret", term: "spill", ...overrides };
}

async function pasteAndPreview(text: string): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Paste your list"), text);
  await user.click(screen.getByRole("button", { name: "Preview" }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedImport.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("MemoryImport paste phase", () => {
  it("disables Preview until the paste is non-blank", async () => {
    const user = userEvent.setup();
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    await user.type(screen.getByLabelText("Paste your list"), "per");
    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("cancels back to the caller", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<MemoryImport onCancel={onCancel} onImported={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryImport review + import", () => {
  it("imports each line as an item, splitting answers only on explicit separators", async () => {
    const onImported = vi.fn();
    render(<MemoryImport onCancel={vi.fn()} onImported={onImported} />);

    const user = await pasteAndPreview("per = each\nserendipity");
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [
          {
            captureSource: "import",
            noteText: "per",
            prompts: [{ cueText: "per", answerText: "each" }]
          },
          {
            captureSource: "import",
            noteText: "serendipity",
            prompts: [{ cueText: "serendipity" }]
          }
        ]
      })
    );
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("folds indented context into the note body, including edits to it", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("push back -> pushback\n    resisted the plan");
    const context = screen.getByLabelText("Context");
    await user.type(context, " in full");
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [
          {
            captureSource: "import",
            noteText: "push back\n\nresisted the plan in full",
            prompts: [{ cueText: "push back", answerText: "pushback" }]
          }
        ]
      })
    );
  });

  it("applies edits to the cue and answer before importing", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("per = each");
    const cue = screen.getByLabelText("Cue");
    await user.clear(cue);
    await user.type(cue, "per annum");
    const answer = screen.getByLabelText("Answer");
    await user.clear(answer);
    await user.type(answer, "each year");
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [
          {
            captureSource: "import",
            noteText: "per annum",
            prompts: [{ cueText: "per annum", answerText: "each year" }]
          }
        ]
      })
    );
  });

  it("undoes a proposed split, importing the whole heading as an answerless cue", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("per = each");
    await user.click(screen.getByRole("button", { name: "Undo split" }));
    // The Undo split control disappears once there is no proposed split.
    expect(screen.queryByRole("button", { name: "Undo split" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [
          { captureSource: "import", noteText: "per = each", prompts: [{ cueText: "per = each" }] }
        ]
      })
    );
  });

  it("merges an adjacent draft into the earlier one's context", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("alpha\nbeta");
    await user.click(screen.getByRole("button", { name: "Merge with next" }));
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [
          { captureSource: "import", noteText: "alpha\n\nbeta", prompts: [{ cueText: "alpha" }] }
        ]
      })
    );
  });

  it("splits a context line off into its own draft", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("push back -> pushback\n    resisted the plan");
    await user.click(screen.getByRole("button", { name: "Split off context" }));
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [
          {
            captureSource: "import",
            noteText: "push back",
            prompts: [{ cueText: "push back", answerText: "pushback" }]
          },
          {
            captureSource: "import",
            noteText: "resisted the plan",
            prompts: [{ cueText: "resisted the plan" }]
          }
        ]
      })
    );
  });

  it("removes a draft so it is not imported", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("keep\ndrop");
    // The second draft's Remove button is the last one rendered.
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await user.click(removeButtons[1]!);
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [{ captureSource: "import", noteText: "keep", prompts: [{ cueText: "keep" }] }]
      })
    );
  });

  it("fills an answerless draft from the offline dictionary", async () => {
    mockedSuggest.mockResolvedValue(suggestion());
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("spill");
    await user.click(screen.getByRole("button", { name: "Suggest answer" }));

    await waitFor(() =>
      expect((screen.getByLabelText("Answer") as HTMLInputElement).value).toBe("to reveal a secret")
    );
    await user.click(screen.getByRole("button", { name: /^Import/ }));
    await waitFor(() =>
      expect(mockedImport).toHaveBeenCalledWith({
        items: [
          {
            captureSource: "import",
            noteText: "spill",
            prompts: [{ cueText: "spill", answerText: "to reveal a secret" }]
          }
        ]
      })
    );
  });

  it("reports when the dictionary has no suggestion for a term", async () => {
    mockedSuggest.mockResolvedValue(suggestion({ suggestion: null, term: "florb" }));
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("florb");
    await user.click(screen.getByRole("button", { name: "Suggest answer" }));

    expect(await screen.findByText(/No dictionary suggestion for/)).toBeDefined();
  });

  it("does not call the dictionary when the cue is blank", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("florb");
    await user.clear(screen.getByLabelText("Cue"));
    await user.click(screen.getByRole("button", { name: "Suggest answer" }));

    expect(mockedSuggest).not.toHaveBeenCalled();
  });

  it("surfaces an error when the dictionary lookup fails", async () => {
    mockedSuggest.mockRejectedValue(new Error("boom"));
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("spill");
    await user.click(screen.getByRole("button", { name: "Suggest answer" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was saved/);
  });

  it("keeps every draft and reports failure when the import fails atomically", async () => {
    mockedImport.mockRejectedValue(new Error("boom"));
    const onImported = vi.fn();
    render(<MemoryImport onCancel={vi.fn()} onImported={onImported} />);

    const user = await pasteAndPreview("per = each\nserendipity");
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was saved/);
    // Both drafts survive the failed import (nothing was lost).
    expect(screen.getAllByLabelText("Cue")).toHaveLength(2);
    expect(onImported).not.toHaveBeenCalled();
  });

  it("guards against a double submit while an import is in flight", async () => {
    let resolveImport: () => void = () => undefined;
    mockedImport.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = () => resolve([]);
      })
    );
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("per = each");
    const importButton = screen.getByRole("button", { name: /^Import/ });
    await user.click(importButton);
    // While pending the button is disabled, so a second click cannot fire another request.
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(importButton);
    expect(mockedImport).toHaveBeenCalledTimes(1);
    resolveImport();
  });

  it("returns to the paste phase preserving the original text", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("per = each");
    await user.click(screen.getByRole("button", { name: "Back to paste" }));

    expect((screen.getByLabelText("Paste your list") as HTMLTextAreaElement).value).toBe(
      "per = each"
    );
  });

  it("refuses to import and reports when every cue is blank", async () => {
    render(<MemoryImport onCancel={vi.fn()} onImported={vi.fn()} />);

    const user = await pasteAndPreview("per");
    await user.clear(screen.getByLabelText("Cue"));
    await user.click(screen.getByRole("button", { name: /^Import/ }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Add at least one term with a cue"
    );
    expect(mockedImport).not.toHaveBeenCalled();
  });
});
