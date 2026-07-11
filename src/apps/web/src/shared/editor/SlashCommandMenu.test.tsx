// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BlockCommand } from "./blockCommands";
import { SlashCommandMenu, type SlashCommandMenuHandle } from "./SlashCommandMenu";

function command(id: string, label: string): BlockCommand {
  return { aliases: [], appendTo: (chain) => chain, id, isAvailable: () => true, label };
}

const items: readonly BlockCommand[] = [
  command("paragraph", "Text"),
  command("heading-1", "Heading 1"),
  command("code-block", "Code block")
];

function key(name: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: name });
}

function press(ref: React.RefObject<SlashCommandMenuHandle | null>, name: string): boolean {
  let handled = false;
  act(() => {
    handled = ref.current?.onKeyDown(key(name)) ?? false;
  });
  return handled;
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
    writable: true
  });
});

afterEach(() => {
  cleanup();
});

function renderMenu(overrides: Partial<React.ComponentProps<typeof SlashCommandMenu>> = {}) {
  const ref = createRef<SlashCommandMenuHandle>();
  const onSelect = vi.fn();
  const view = render(
    <SlashCommandMenu items={items} onSelect={onSelect} query="" ref={ref} {...overrides} />
  );

  return { onSelect, ref, ...view };
}

describe("SlashCommandMenu", () => {
  it("renders a labelled listbox with an option per command and the first active", () => {
    renderMenu();

    const listbox = screen.getByRole("listbox", { name: "Block commands" });
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Text",
      "Heading 1",
      "Code block"
    ]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options[1]?.getAttribute("aria-selected")).toBe("false");
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
  });

  it("announces the result count and the active option", () => {
    renderMenu();

    expect(screen.getByRole("status").textContent).toBe("3 commands available. Text selected.");
  });

  it("announces a single available command in the singular", () => {
    renderMenu({ items: [command("paragraph", "Text")] });

    expect(screen.getByRole("status").textContent).toBe("1 command available. Text selected.");
  });

  it("moves the active option down and up with wraparound", () => {
    const { ref } = renderMenu();

    expect(press(ref, "ArrowDown")).toBe(true);
    let options = screen.getAllByRole("option");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    press(ref, "ArrowDown");
    press(ref, "ArrowDown");
    options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    press(ref, "ArrowUp");
    options = screen.getAllByRole("option");
    expect(options[2]?.getAttribute("aria-selected")).toBe("true");
  });

  it("selects the active command on Enter", () => {
    const { onSelect, ref } = renderMenu();

    press(ref, "ArrowDown");
    expect(press(ref, "Enter")).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("does not consume unrelated keys", () => {
    const { ref } = renderMenu();

    expect(press(ref, "a")).toBe(false);
  });

  it("selects a command on pointer press without moving focus", () => {
    const { onSelect } = renderMenu();

    const option = screen.getByRole("option", { name: "Code block" });
    const event = fireEvent.pointerDown(option);

    expect(event).toBe(false); // preventDefault() was called, so dispatchEvent returns false
    expect(onSelect).toHaveBeenCalledWith(items[2]);
  });

  it("activates the option the pointer enters", () => {
    renderMenu();

    fireEvent.pointerEnter(screen.getByRole("option", { name: "Heading 1" }));
    expect(screen.getByRole("option", { name: "Heading 1" }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("scrolls the active option into view when it changes", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
      writable: true
    });
    const { ref } = renderMenu();
    scrollIntoView.mockClear();

    press(ref, "ArrowDown");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("does not throw when scrollIntoView is unavailable", () => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    const { ref } = renderMenu();

    expect(() => press(ref, "ArrowDown")).not.toThrow();
  });

  it("renders an empty state and ignores keys when nothing matches, keyed by query", () => {
    const { ref, rerender } = renderMenu({ items: [], query: "zzz" });

    expect(screen.getByText("No commands")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No commands match zzz.");
    expect(press(ref, "ArrowDown")).toBe(false);
    expect(press(ref, "Enter")).toBe(false);

    rerender(<SlashCommandMenu items={[]} onSelect={vi.fn()} query="" ref={ref} />);
    expect(screen.getByRole("status").textContent).toBe("No commands.");
  });

  it("resets the active option to the top when the result set shrinks", () => {
    const { ref, rerender } = renderMenu();

    press(ref, "ArrowDown");
    press(ref, "ArrowDown");

    rerender(
      <SlashCommandMenu
        items={[command("paragraph", "Text")]}
        onSelect={vi.fn()}
        query=""
        ref={ref}
      />
    );

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
  });
});
