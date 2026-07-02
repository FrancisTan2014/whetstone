// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shelf and the content panel are exercised by their own tests; here we isolate the app-level
// composition (which work the "Manage content" sheet opens for, and that closing unmounts it) by
// stubbing both features with minimal doubles.
vi.mock("../features/library/AdminLibraryPage", () => ({
  AdminLibraryPage: ({
    onManageContent
  }: {
    onManageContent: (workEntryId: string) => void;
  }): React.JSX.Element => (
    <button onClick={() => onManageContent("work-42")} type="button">
      Manage work-42
    </button>
  )
}));

vi.mock("../features/content/WorkContentPanel", () => ({
  WorkContentPanel: ({ focusWorkEntryId }: { focusWorkEntryId?: string }): React.JSX.Element => (
    <p>Panel for {focusWorkEntryId}</p>
  )
}));

import { LibraryMode } from "./LibraryMode";

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

beforeEach(() => {
  mockMatchMedia();
});

afterEach(() => {
  cleanup();
});

describe("LibraryMode", () => {
  it("shows the shelf with no manage-content sheet until a work is chosen", () => {
    render(<LibraryMode />);

    expect(screen.getByRole("button", { name: "Manage work-42" })).toBeDefined();
    expect(screen.queryByText("Panel for work-42")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the manage-content sheet for the chosen work and closes it on dismiss", async () => {
    const user = userEvent.setup();
    render(<LibraryMode />);

    await user.click(screen.getByRole("button", { name: "Manage work-42" }));

    const dialog = await screen.findByRole("dialog");
    expect(screen.getByText("Manage content")).toBeDefined();
    expect(screen.getByText("Panel for work-42")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByText("Panel for work-42")).toBeNull();
    });
    expect(dialog).toBeDefined();
  });
});
