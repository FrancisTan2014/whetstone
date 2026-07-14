// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memoryApi", () => ({
  editMemoryPrompt: vi.fn()
}));

import type { MemoryPromptDto } from "@whetstone/contracts";

import { editMemoryPrompt } from "./memoryApi";
import { MemoryPromptRow } from "./MemoryPromptRow";

const mockedEdit = vi.mocked(editMemoryPrompt);

function makePrompt(overrides: Partial<MemoryPromptDto> = {}): MemoryPromptDto {
  return {
    answerText: null,
    chunkId: null,
    cueText: "spill the beans",
    lifecycle: "draft",
    noteId: "note-1",
    promptId: "prompt-1",
    review: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedEdit.mockResolvedValue(makePrompt());
});

afterEach(() => {
  cleanup();
});

describe("MemoryPromptRow", () => {
  it("shows a scheduled prompt's lifecycle and prefilled fields", () => {
    render(
      <MemoryPromptRow
        onSaved={vi.fn()}
        prompt={makePrompt({ answerText: "to reveal a secret", lifecycle: "ready" })}
      />
    );

    expect(screen.getByText("Scheduled")).toBeDefined();
    expect((screen.getByLabelText("Cue") as HTMLInputElement).value).toBe("spill the beans");
    expect((screen.getByLabelText("Answer") as HTMLInputElement).value).toBe("to reveal a secret");
  });

  it("shows a draft prompt's lifecycle with an empty answer", () => {
    render(<MemoryPromptRow onSaved={vi.fn()} prompt={makePrompt()} />);

    expect(screen.getByText("Draft")).toBeDefined();
    expect((screen.getByLabelText("Answer") as HTMLInputElement).value).toBe("");
  });

  it("saves an answered edit and reloads via onSaved", async () => {
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<MemoryPromptRow onSaved={onSaved} prompt={makePrompt()} />);

    await user.type(screen.getByLabelText("Answer"), "to reveal a secret");
    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    await waitFor(() =>
      expect(mockedEdit).toHaveBeenCalledWith("prompt-1", {
        answerText: "to reveal a secret",
        cueText: "spill the beans"
      })
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("sends an explicit null answer when the answer is cleared", async () => {
    const user = userEvent.setup();
    render(
      <MemoryPromptRow
        onSaved={vi.fn()}
        prompt={makePrompt({ answerText: "to reveal a secret", lifecycle: "ready" })}
      />
    );

    await user.clear(screen.getByLabelText("Answer"));
    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    await waitFor(() =>
      expect(mockedEdit).toHaveBeenCalledWith("prompt-1", {
        answerText: null,
        cueText: "spill the beans"
      })
    );
  });

  it("surfaces an error and does not reload when saving fails", async () => {
    mockedEdit.mockRejectedValue(new Error("boom"));
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<MemoryPromptRow onSaved={onSaved} prompt={makePrompt()} />);

    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not save that prompt/);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("disables saving when the cue is cleared", async () => {
    const user = userEvent.setup();
    render(<MemoryPromptRow onSaved={vi.fn()} prompt={makePrompt()} />);

    await user.clear(screen.getByLabelText("Cue"));

    expect(
      (screen.getByRole("button", { name: "Save prompt" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("keeps its fields across a parent rerender (stable memoized props)", () => {
    const prompt = makePrompt();
    const onSaved = vi.fn();
    const view = render(<MemoryPromptRow onSaved={onSaved} prompt={prompt} />);

    expect((screen.getByLabelText("Cue") as HTMLInputElement).value).toBe("spill the beans");
    view.rerender(<MemoryPromptRow onSaved={onSaved} prompt={prompt} />);

    expect((screen.getByLabelText("Cue") as HTMLInputElement).value).toBe("spill the beans");
  });
});
