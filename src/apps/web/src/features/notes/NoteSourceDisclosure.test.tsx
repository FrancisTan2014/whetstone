// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { NoteSourceDisclosure } from "./NoteSourceDisclosure";
import { type NoteWorkspaceSource } from "./noteWorkspaceModel";

function source(overrides: Partial<NoteWorkspaceSource> = {}): NoteWorkspaceSource {
  return { blockEntryId: "block-1", snapshot: "the exact source", workEntryId: "work-1", ...overrides };
}

afterEach(() => cleanup());

describe("NoteSourceDisclosure", () => {
  it("shows the selected text as read-only source, clamped until expanded", async () => {
    render(<NoteSourceDisclosure source={source()} />);
    const text = screen.getByText(/the exact source/);

    expect(text.textContent).toContain("Source:");
    expect(text.className).toContain("noteWorkspaceSourceText--clamped");

    const toggle = screen.getByRole("button", { name: "Show full source" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(toggle);
    expect(text.className).not.toContain("noteWorkspaceSourceText--clamped");
    const collapse = screen.getByRole("button", { name: "Hide source" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");

    await userEvent.click(collapse);
    expect(screen.getByText(/the exact source/).className).toContain(
      "noteWorkspaceSourceText--clamped"
    );
  });

  it("offers Open in Reader linking to the anchored block when it resolves", () => {
    render(<NoteSourceDisclosure source={source()} />);
    expect(screen.getByRole("link", { name: "Open in Reader" }).getAttribute("href")).toBe(
      "#/reader?work=work-1&block=block-1"
    );
  });

  it("omits Open in Reader when the anchored location is unknown", () => {
    render(<NoteSourceDisclosure source={source({ blockEntryId: null })} />);
    expect(screen.queryByRole("link", { name: "Open in Reader" })).toBeNull();
  });
});
