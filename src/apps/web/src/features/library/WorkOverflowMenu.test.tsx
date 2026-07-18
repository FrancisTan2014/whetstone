// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { WorkOverflowMenu } from "./WorkOverflowMenu";

beforeAll(() => {
  // Radix DropdownMenu reads pointer-capture and layout APIs jsdom lacks; stub them so opening the menu
  // during interaction tests does not throw.
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {}
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {}
  });
});

afterEach(() => {
  cleanup();
});

const item: WorkListItemDto = {
  author: { id: toAuthorId("author-1"), name: "George Orwell" },
  work: {
    authorId: toAuthorId("author-1"),
    entryId: toEntryId("work-1"),
    language: "en",
    title: "Politics and the English Language",
    workType: "essay"
  }
};

function setup(overrides: Partial<Parameters<typeof WorkOverflowMenu>[0]> = {}) {
  const onRecite = vi.fn();
  const onManageContent = vi.fn();
  const onDelete = vi.fn();
  const user = userEvent.setup();
  render(
    <WorkOverflowMenu
      authored={false}
      enrolled={false}
      enrolling={false}
      item={item}
      onDelete={onDelete}
      onManageContent={onManageContent}
      onRecite={onRecite}
      {...overrides}
    />
  );
  return { onDelete, onManageContent, onRecite, user };
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(
    screen.getByRole("button", { name: "More actions for Politics and the English Language" })
  );
  // Radix labels the menu by its trigger, so its accessible name matches the trigger's.
  return screen.findByRole("menu", {
    name: "More actions for Politics and the English Language"
  });
}

describe("WorkOverflowMenu", () => {
  it("lists actions for an un-enrolled, imported Work in the fixed order", async () => {
    const { user } = setup();
    const menu = await openMenu(user);

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((node) => node.textContent)
    ).toEqual(["I can recite this", "View notes", "Manage content", "Delete work"]);
    expect(within(menu).getByRole("menuitem", { name: "View notes" }).getAttribute("href")).toBe(
      "#/notes?work=work-1"
    );
  });

  it("lists Open in Recite and Edit document for an enrolled, authored Work", async () => {
    const { user } = setup({ authored: true, enrolled: true });
    const menu = await openMenu(user);

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((node) => node.textContent)
    ).toEqual(["Open in Recite", "View notes", "Edit document", "Delete work"]);
    expect(
      within(menu).getByRole("menuitem", { name: "Open in Recite" }).getAttribute("href")
    ).toBe("#/recite");
    expect(within(menu).getByRole("menuitem", { name: "Edit document" }).getAttribute("href")).toBe(
      "#/write?work=work-1"
    );
  });

  it("enrolls the Work when 'I can recite this' is chosen", async () => {
    const { onRecite, user } = setup();
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole("menuitem", { name: "I can recite this" }));

    expect(onRecite).toHaveBeenCalledTimes(1);
  });

  it("disables 'I can recite this' while its enrolment is in flight", async () => {
    const { onRecite, user } = setup({ enrolling: true });
    const menu = await openMenu(user);

    const recite = within(menu).getByRole("menuitem", { name: "I can recite this" });
    expect(recite.getAttribute("aria-disabled")).toBe("true");

    await user.click(recite);
    expect(onRecite).not.toHaveBeenCalled();
  });

  it("opens the manage-content surface for an imported Work", async () => {
    const { onManageContent, user } = setup();
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole("menuitem", { name: "Manage content" }));

    expect(onManageContent).toHaveBeenCalledTimes(1);
  });

  it("runs the delete flow from the visually separated destructive item", async () => {
    const { onDelete, user } = setup();
    const menu = await openMenu(user);

    // A separator sets the destructive Delete apart from the routine actions.
    expect(within(menu).getByRole("separator")).toBeDefined();
    await user.click(within(menu).getByRole("menuitem", { name: "Delete work" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { user } = setup();
    await openMenu(user);

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.queryByRole("menu", {
          name: "More actions for Politics and the English Language"
        })
      ).toBeNull();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "More actions for Politics and the English Language" })
    );
  });
});
