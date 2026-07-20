// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LibraryAddMenu } from "./LibraryAddMenu";

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

function setup(overrides: Partial<Parameters<typeof LibraryAddMenu>[0]> = {}) {
  const onUploadFile = vi.fn();
  const onAddWorkManually = vi.fn();
  const user = userEvent.setup();
  render(
    <LibraryAddMenu
      busy={false}
      onAddWorkManually={onAddWorkManually}
      onUploadFile={onUploadFile}
      {...overrides}
    />
  );
  return { onAddWorkManually, onUploadFile, user };
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Add" }));
  // Radix labels the menu by its trigger (aria-labelledby), so the menu's accessible name is "Add".
  return screen.findByRole("menu", { name: "Add" });
}

describe("LibraryAddMenu", () => {
  it("exposes exactly the two source add actions with the upload format hint", async () => {
    const { user } = setup();
    const menu = await openMenu(user);

    const items = within(menu).getAllByRole("menuitem");
    // Creating an authored document moved to the Write destination (#679); Library only adds source
    // material now — no "New document" item remains here.
    expect(items.map((item) => item.textContent)).toEqual([
      "Upload file.epub, .pdf, .md",
      "Add work manually"
    ]);
  });

  it("runs the upload flow when Upload file is chosen", async () => {
    const { onUploadFile, onAddWorkManually, user } = setup();
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole("menuitem", { name: /Upload file/ }));

    expect(onUploadFile).toHaveBeenCalledTimes(1);
    expect(onAddWorkManually).not.toHaveBeenCalled();
  });

  it("runs the manual add-work flow when Add work manually is chosen", async () => {
    const { onAddWorkManually, user } = setup();
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole("menuitem", { name: "Add work manually" }));

    expect(onAddWorkManually).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { user } = setup();
    await openMenu(user);

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });

  it("disables and marks the trigger busy while an upload is ingesting", () => {
    setup({ busy: true });

    const trigger = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
  });
});
