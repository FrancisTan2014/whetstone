// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthoredWorkDto } from "@whetstone/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./authoredWorkApi", () => ({
  fetchAuthoredWork: vi.fn(),
  saveAuthoredWorkContent: vi.fn()
}));

vi.mock("../../shared/editor/index.js", async () => {
  const { createTextDocument, documentText } = await import("@whetstone/document");
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
      onSave?: (document: unknown) => void;
    }) =>
      React.createElement(React.Fragment, null, [
        React.createElement("textarea", {
          "aria-label": ariaLabel,
          defaultValue: documentText(document as never),
          key: "editor",
          onChange: (event: { target: { value: string } }) =>
            onChange(createTextDocument(event.target.value))
        }),
        React.createElement(
          "button",
          {
            key: "save",
            onClick: () => onSave?.(createTextDocument("explicit save")),
            type: "button"
          },
          "Save document"
        )
      ])
  };
});

vi.mock("../reader/PmDocument.js", async () => {
  const { documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    PmDocument: ({ document }: { document: unknown }) =>
      React.createElement("p", { "data-testid": "pm-document" }, documentText(document as never))
  };
});

import { createTextDocument } from "@whetstone/document";

import { fetchAuthoredWork, saveAuthoredWorkContent } from "./authoredWorkApi";
import { AuthoredWorkPage } from "./AuthoredWorkPage";

const mockedFetch = vi.mocked(fetchAuthoredWork);
const mockedSave = vi.mocked(saveAuthoredWorkContent);

const work: AuthoredWorkDto = {
  createdAt: "2026-07-01T00:00:00.000Z",
  document: createTextDocument("First words"),
  entryId: "work-1",
  language: "en",
  title: "My essay",
  unitEntryId: "unit-1",
  updatedAt: "2026-07-02T00:00:00.000Z",
  workType: "book"
};

beforeEach(() => {
  mockedFetch.mockResolvedValue(work);
  mockedSave.mockResolvedValue(work);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AuthoredWorkPage", () => {
  it("prompts to open a document when no work is selected", () => {
    render(<AuthoredWorkPage workEntryId={undefined} />);

    expect(screen.getByText(/No document selected/i)).toBeDefined();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("loads the work and opens it in the editor", async () => {
    render(<AuthoredWorkPage workEntryId="work-1" />);

    expect(await screen.findByRole("textbox", { name: "Edit My essay" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "My essay" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Saved");
  });

  it("surfaces a calm error when the document cannot be opened", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("gone"));
    render(<AuthoredWorkPage workEntryId="missing" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn.t open this document/i);
  });

  it("autosaves an edit after the debounce, showing saving then saved", async () => {
    render(<AuthoredWorkPage workEntryId="work-1" />);
    const editor = await screen.findByRole("textbox", { name: "Edit My essay" });

    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "New content" } });
      expect(screen.getByRole("status").textContent).toContain("Unsaved changes");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(mockedSave).toHaveBeenCalledTimes(1);
      expect(mockedSave.mock.calls[0]?.[0]).toBe("work-1");
      expect(screen.getByRole("status").textContent).toContain("Saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves immediately on an explicit save", async () => {
    const user = userEvent.setup();
    render(<AuthoredWorkPage workEntryId="work-1" />);
    await screen.findByRole("textbox", { name: "Edit My essay" });

    await user.click(screen.getByRole("button", { name: "Save document" }));

    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
  });

  it("switches between edit and read modes, rendering the saved document in the reader", async () => {
    const user = userEvent.setup();
    render(<AuthoredWorkPage workEntryId="work-1" />);
    await screen.findByRole("textbox", { name: "Edit My essay" });

    await user.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByTestId("pm-document").textContent).toContain("First words");
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Edit My essay" })).toBeDefined();
  });

  it("does not update state after a resolved load once unmounted", async () => {
    let resolveLoad!: (value: AuthoredWorkDto) => void;
    mockedFetch.mockReturnValueOnce(
      new Promise<AuthoredWorkDto>((resolve) => {
        resolveLoad = resolve;
      })
    );
    const { unmount } = render(<AuthoredWorkPage workEntryId="work-1" />);
    unmount();

    await act(async () => {
      resolveLoad(work);
    });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not update state after a failed load once unmounted", async () => {
    let rejectLoad!: (error: Error) => void;
    mockedFetch.mockReturnValueOnce(
      new Promise<AuthoredWorkDto>((_resolve, reject) => {
        rejectLoad = reject;
      })
    );
    const { unmount } = render(<AuthoredWorkPage workEntryId="work-1" />);
    unmount();

    await act(async () => {
      rejectLoad(new Error("gone"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
