// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memoryApi", () => ({
  createMemory: vi.fn(),
  suggestGloss: vi.fn()
}));

import type { MemoryDepositDto, MemoryGlossSuggestionDto } from "@whetstone/contracts";

import { createMemory, suggestGloss } from "./memoryApi";
import { MemoryQuickAdd } from "./MemoryQuickAdd";

const mockedCreate = vi.mocked(createMemory);
const mockedSuggest = vi.mocked(suggestGloss);

const deposit: MemoryDepositDto = {
  note: {
    bodyText: "spill the beans",
    captureSource: "manual",
    derivedFromEntryId: null,
    noteId: "note-1"
  },
  prompts: []
};

function suggestion(overrides: Partial<MemoryGlossSuggestionDto> = {}): MemoryGlossSuggestionDto {
  return { suggestion: "to reveal a secret", term: "spill the beans", ...overrides };
}

function value(element: HTMLElement): string {
  return (element as HTMLInputElement).value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCreate.mockResolvedValue(deposit);
});

afterEach(() => {
  cleanup();
});

describe("MemoryQuickAdd compact capture", () => {
  it("does not look up or save when the term is blank", async () => {
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(mockedSuggest).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("saves an unknown term straight away as a draft and confirms inline", async () => {
    mockedSuggest.mockResolvedValue(suggestion({ suggestion: null, term: "florb" }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={onCreated} />);

    await user.type(screen.getByLabelText("Add to Memory"), "florb");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        captureSource: "manual",
        noteText: "florb",
        prompts: [{ cueText: "florb" }]
      })
    );
    expect(await screen.findByText(/Saved .*florb.* as a draft/)).toBeDefined();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("reveals a confirm row prefilled with the dictionary suggestion without saving yet", async () => {
    mockedSuggest.mockResolvedValue(suggestion());
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("Add to Memory"), "spill the beans");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const answer = await screen.findByLabelText("Answer");
    expect(value(answer)).toBe("to reveal a secret");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("schedules with the edited answer when Save is pressed in the confirm row", async () => {
    mockedSuggest.mockResolvedValue(suggestion());
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={onCreated} />);

    await user.type(screen.getByLabelText("Add to Memory"), "spill the beans");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const answer = await screen.findByLabelText("Answer");
    await user.clear(answer);
    await user.type(answer, "to disclose");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        captureSource: "manual",
        noteText: "spill the beans",
        prompts: [{ answerText: "to disclose", cueText: "spill the beans" }]
      })
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("saves a draft from the confirm row when Save as draft is pressed", async () => {
    mockedSuggest.mockResolvedValue(suggestion());
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("Add to Memory"), "spill the beans");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByLabelText("Answer");
    await user.click(screen.getByRole("button", { name: "Save as draft" }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        captureSource: "manual",
        noteText: "spill the beans",
        prompts: [{ cueText: "spill the beans" }]
      })
    );
  });

  it("disables Save when the confirm answer is cleared", async () => {
    mockedSuggest.mockResolvedValue(suggestion());
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("Add to Memory"), "spill the beans");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const answer = await screen.findByLabelText("Answer");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false
    );
    await user.clear(answer);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces an error when the dictionary lookup fails", async () => {
    mockedSuggest.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("Add to Memory"), "spill the beans");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not save/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("surfaces an error when saving from the confirm row fails", async () => {
    mockedSuggest.mockResolvedValue(suggestion());
    mockedCreate.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("Add to Memory"), "spill the beans");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByLabelText("Answer");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not save/);
  });
});

describe("MemoryQuickAdd detailed capture", () => {
  it("toggles the detailed form open and closed", async () => {
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    expect(screen.getByLabelText("Add to Memory")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Add details" }));
    expect(screen.getByLabelText("Cue")).toBeDefined();
    expect(screen.queryByLabelText("Add to Memory")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.getByLabelText("Add to Memory")).toBeDefined();
    expect(screen.queryByLabelText("Cue")).toBeNull();
  });

  it("requires at least one cue before saving the detailed form", async () => {
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add details" }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Add at least one cue to save."
    );
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("saves a single answerless direction as a draft using the cue as the body", async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={onCreated} />);

    await user.click(screen.getByRole("button", { name: "Add details" }));
    await user.type(screen.getByLabelText("Cue"), "mitigation");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        captureSource: "manual",
        noteText: "mitigation",
        prompts: [{ cueText: "mitigation" }]
      })
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("combines the cue and context into the body and schedules an answered direction", async () => {
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add details" }));
    await user.type(screen.getByLabelText("Cue"), "mitigation");
    await user.type(screen.getByLabelText("Answer"), "a way to reduce risk");
    await user.type(screen.getByLabelText("Context or example"), "wear a helmet");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        captureSource: "manual",
        noteText: "mitigation\n\nwear a helmet",
        prompts: [{ answerText: "a way to reduce risk", cueText: "mitigation" }]
      })
    );
  });

  it("adds multiple directions and skips fully empty extra rows", async () => {
    const user = userEvent.setup();
    render(<MemoryQuickAdd onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add details" }));
    await user.type(screen.getAllByLabelText("Cue")[0]!, "cue one");
    await user.type(screen.getAllByLabelText("Answer")[0]!, "answer one");

    await user.click(screen.getByRole("button", { name: "Add another direction" }));
    await user.type(screen.getAllByLabelText("Cue")[1]!, "cue two");

    await user.click(screen.getByRole("button", { name: "Add another direction" }));
    // The third row is left entirely empty and must be skipped.

    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        captureSource: "manual",
        noteText: "cue one",
        prompts: [
          { answerText: "answer one", cueText: "cue one" },
          { cueText: "cue two" }
        ]
      })
    );
  });
});
