// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "./ThemeToggle";
import { themeStorageKey } from "./theme";

function mockMatchMedia(prefersDark: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    removeEventListener: vi.fn()
  }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
});

describe("ThemeToggle", () => {
  it("defaults to Day, leaves `.dark` off, and persists the choice", () => {
    render(<ThemeToggle />);

    expect(screen.getByRole("button", { name: "Switch to Night" })).toBeDefined();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(themeStorageKey)).toBe("day");
  });

  it("toggles to Night, sets `.dark`, and persists the choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Switch to Night" }));

    const switched = screen.getByRole("button", { name: "Switch to Day" });
    expect(switched.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(themeStorageKey)).toBe("night");
  });

  it("honors the system Night preference on first load", () => {
    mockMatchMedia(true);

    render(<ThemeToggle />);

    expect(screen.getByRole("button", { name: "Switch to Day" })).toBeDefined();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("restores a persisted Night choice over a Day system preference", () => {
    window.localStorage.setItem(themeStorageKey, "night");

    render(<ThemeToggle />);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
