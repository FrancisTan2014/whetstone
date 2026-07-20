// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AuthoredWorkDto, AuthoredWorkSummaryDto } from "@whetstone/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./authoredWorkApi", () => ({
  createAuthoredWork: vi.fn(),
  listAuthoredWorks: vi.fn()
}));

import { createAuthoredWork, listAuthoredWorks } from "./authoredWorkApi";
import { ToastProvider } from "../../shared/ui/toast/ToastProvider";
import { ToastViewport } from "../../shared/ui/toast/ToastViewport";
import { WritingHomePage } from "./WritingHomePage";

const mockedCreate = vi.mocked(createAuthoredWork);
const mockedList = vi.mocked(listAuthoredWorks);

// Reflects the router location so a create can be asserted to navigate into the editor with the exact,
// URL-encoded work id — the same canonical Work the API returned (no duplicate creation path).
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderHome(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/write"]}>
      <ToastProvider>
        <WritingHomePage />
        <LocationProbe />
        <ToastViewport />
      </ToastProvider>
    </MemoryRouter>
  );
}

function summary(overrides: Partial<AuthoredWorkSummaryDto> = {}): AuthoredWorkSummaryDto {
  return {
    createdAt: "2026-07-01T00:00:00.000Z",
    entryId: "work-1",
    language: "en",
    title: "My essay",
    updatedAt: "2026-07-02T00:00:00.000Z",
    workType: "essay",
    ...overrides
  };
}

function mockMatchMedia(): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  }));
}

beforeAll(() => {
  // Radix Dialog (the New essay sheet) reads pointer-capture/layout APIs jsdom lacks; stub them so
  // opening the sheet during interaction tests does not throw.
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture"
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: () => false
    });
  }
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {}
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockMatchMedia();
});

afterEach(() => {
  cleanup();
});

describe("WritingHomePage", () => {
  it("shows a distinct loading state that cannot masquerade as empty", () => {
    // A never-resolving load keeps the page in its loading arm.
    mockedList.mockReturnValue(new Promise(() => {}));
    renderHome();

    expect(screen.getByText("Loading your writing…")).toBeDefined();
    expect(screen.queryByText(/saved as Works/i)).toBeNull();
  });

  it("surfaces a failure with a specific retry that recovers, never a blank empty state", async () => {
    mockedList.mockRejectedValueOnce(new Error("down"));
    const user = userEvent.setup();
    renderHome();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/load your writing/i)).toBeDefined();
    // The failure is not the empty on-ramp.
    expect(screen.queryByText(/saved as Works/i)).toBeNull();

    mockedList.mockResolvedValueOnce({ works: [summary({ title: "Recovered essay" })] });
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Recovered essay" })).toBeDefined();
  });

  it("explains the empty state and leads with New essay", async () => {
    mockedList.mockResolvedValueOnce({ works: [] });
    renderHome();

    expect(await screen.findByText(/saved as Works in your Library/i)).toBeDefined();
    // New essay is the header primary action, present even when there is nothing yet.
    expect(screen.getByRole("button", { name: "New essay" })).toBeDefined();
  });

  it("lists authored Works newest-edit first with title, type/language, last-edited, Continue and Read", async () => {
    const older = summary({
      entryId: "work-old",
      title: "Older draft",
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const newer = summary({
      entryId: "work-new",
      language: "en",
      title: "Newer draft",
      updatedAt: "2026-07-05T00:00:00.000Z",
      workType: "essay"
    });
    // Provided oldest-first to prove the client sorts rather than trusting input order.
    mockedList.mockResolvedValueOnce({ works: [older, newer] });
    renderHome();

    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((node) => node.textContent)).toEqual(["Newer draft", "Older draft"]);

    const [newerHeading] = headings;
    const newerRow = newerHeading?.closest("li") as HTMLElement;
    expect(within(newerRow).getByText(/essay · English · Last edited Jul 5, 2026/)).toBeDefined();
    expect(
      within(newerRow).getByRole("link", { name: "Continue writing" }).getAttribute("href")
    ).toBe("#/write?work=work-new");
    expect(within(newerRow).getByRole("link", { name: "Read" }).getAttribute("href")).toBe(
      "#/reader?work=work-new"
    );
  });

  it("restores focus to the most-recent row's Continue action on return", async () => {
    mockedList.mockResolvedValueOnce({
      works: [
        summary({ entryId: "work-a", title: "First", updatedAt: "2026-07-09T00:00:00.000Z" }),
        summary({ entryId: "work-b", title: "Second", updatedAt: "2026-07-08T00:00:00.000Z" })
      ]
    });
    renderHome();

    const [firstContinue] = await screen.findAllByRole("link", { name: "Continue writing" });
    await waitFor(() => {
      expect(document.activeElement).toBe(firstContinue);
    });
    expect(firstContinue?.getAttribute("href")).toBe("#/write?work=work-a");
  });

  it("creates a Work defaulting the type to essay and opens its editor with the same id", async () => {
    mockedList.mockResolvedValueOnce({ works: [] });
    const created: AuthoredWorkDto = {
      createdAt: "2026-07-01T00:00:00.000Z",
      document: { content: [], type: "doc" },
      entryId: "doc 7",
      language: "zh-CN",
      title: "Nouvelle",
      unitEntryId: "unit-1",
      updatedAt: "2026-07-01T00:00:00.000Z",
      workType: "essay"
    };
    mockedCreate.mockResolvedValueOnce(created);
    const user = userEvent.setup();
    renderHome();
    await screen.findByText(/saved as Works/i);

    await user.click(screen.getByRole("button", { name: "New essay" }));
    await screen.findByRole("heading", { name: "New essay" });
    await user.type(screen.getByLabelText("Title"), "Nouvelle");
    await user.selectOptions(screen.getByLabelText("Language"), "zh-CN");
    // Deliberately leave Type untouched to prove it defaults to essay.
    await user.click(screen.getByRole("button", { name: "Create and write" }));

    // Wait for the successful create to navigate into the editor (the create resolving, then the
    // navigation flushing) before asserting the destination, so the assertion is not read early.
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/write?work=doc%207");
    });
    expect(mockedCreate).toHaveBeenCalledWith({
      language: "zh-CN",
      title: "Nouvelle",
      workType: "essay"
    });
  });

  it("validates that a title is required and does not create", async () => {
    mockedList.mockResolvedValueOnce({ works: [] });
    const user = userEvent.setup();
    renderHome();
    await screen.findByText(/saved as Works/i);

    await user.click(screen.getByRole("button", { name: "New essay" }));
    await screen.findByRole("heading", { name: "New essay" });
    await user.click(screen.getByRole("button", { name: "Create and write" }));

    expect(await screen.findByText("Enter a document title.")).toBeDefined();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("keeps the form with an error when creation fails", async () => {
    mockedList.mockResolvedValueOnce({ works: [] });
    mockedCreate.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderHome();
    await screen.findByText(/saved as Works/i);

    await user.click(screen.getByRole("button", { name: "New essay" }));
    await screen.findByRole("heading", { name: "New essay" });
    await user.type(screen.getByLabelText("Title"), "Doomed");
    // Also exercise the Type control so a non-default selection is covered.
    await user.selectOptions(screen.getByLabelText("Type"), "book");
    await user.click(screen.getByRole("button", { name: "Create and write" }));

    expect(
      await screen.findAllByText("Could not create the document. Please try again.")
    ).not.toHaveLength(0);
    // The form stays open (the title field is still mounted) rather than losing the entry.
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Doomed");
    expect(screen.getByTestId("location").textContent).toBe("/write");
  });

  it("dismisses the create sheet without creating", async () => {
    mockedList.mockResolvedValueOnce({ works: [] });
    const user = userEvent.setup();
    renderHome();
    await screen.findByText(/saved as Works/i);

    await user.click(screen.getByRole("button", { name: "New essay" }));
    await screen.findByRole("heading", { name: "New essay" });
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "New essay" })).toBeNull();
    });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("ignores a load that settles after the page unmounts", async () => {
    let resolveList: (value: { works: AuthoredWorkSummaryDto[] }) => void = () => {};
    const pending = new Promise<{ works: AuthoredWorkSummaryDto[] }>((resolve) => {
      resolveList = resolve;
    });
    mockedList.mockReturnValueOnce(pending);
    const { unmount } = renderHome();

    unmount();
    resolveList({ works: [summary()] });
    await pending;
    await Promise.resolve();

    // The guarded commit dropped the settled load rather than updating a torn-down tree (no throw / warning).
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});
