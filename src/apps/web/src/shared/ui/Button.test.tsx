// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button, buttonVariants, IconButton } from "./Button";

afterEach(() => {
  cleanup();
});

describe("buttonVariants", () => {
  it("maps each variant to its token classes", () => {
    expect(buttonVariants({ variant: "primary" })).toContain("bg-accent");
    expect(buttonVariants({ variant: "secondary" })).toContain("border-border");
    expect(buttonVariants({ variant: "ghost" })).toContain("bg-transparent");
  });

  it("keeps every size at a >=44px touch target while varying the visual style", () => {
    // min-h-11 = 44px is the floor for every size; lg raises it to min-h-12 (48px).
    expect(buttonVariants({ size: "sm" })).toContain("min-h-11");
    expect(buttonVariants({ size: "sm" })).toContain("text-sm");
    expect(buttonVariants({ size: "md" })).toContain("min-h-11");
    expect(buttonVariants({ size: "lg" })).toContain("min-h-12");
    expect(buttonVariants({ size: "lg" })).toContain("text-lg");
    // icon is a square 44x44 target: the base min-h-11 plus min-w-11 and no horizontal padding.
    expect(buttonVariants({ size: "icon" })).toContain("min-h-11");
    expect(buttonVariants({ size: "icon" })).toContain("min-w-11");
    expect(buttonVariants({ size: "icon" })).toContain("px-0");
    const fallback = buttonVariants({});
    expect(fallback).toContain("bg-accent");
    expect(fallback).toContain("min-h-11");
  });

  it("appends caller-provided classes", () => {
    expect(buttonVariants({ className: "w-full" })).toContain("w-full");
  });
});

describe("Button", () => {
  it("defaults to type=button so it never submits a form", () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("button");
  });

  it("honors an explicit type and variant", () => {
    render(
      <Button type="submit" variant="ghost">
        Send
      </Button>
    );

    const button = screen.getByRole("button", { name: "Send" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.className).toContain("bg-transparent");
  });

  it("shows a spinner, marks busy, and disables while pending", () => {
    render(<Button pending>Create</Button>);

    const button = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("disables for an explicit disabled without a spinner or busy state", () => {
    render(<Button disabled>Create</Button>);

    const button = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.querySelector("svg")).toBeNull();
  });

  it("is enabled with no spinner by default", () => {
    render(<Button>Create</Button>);

    const button = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.querySelector("svg")).toBeNull();
  });
});

describe("IconButton", () => {
  const icon = <svg data-testid="glyph" />;

  it("gives an icon-only control a specific accessible name, tooltip, focus ring, and 44x44 target", () => {
    render(<IconButton icon={icon} label="Close" />);

    const button = screen.getByRole("button", { name: "Close" });
    // Tooltip defaults to the accessible name so hover and screen-reader labels agree.
    expect(button.getAttribute("title")).toBe("Close");
    expect(button.className).toContain("min-w-11");
    expect(button.className).toContain("min-h-11");
    // Visible focus is inherited from the shared Button base, not re-declared.
    expect(button.className).toContain("focus-visible:ring-2");
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("honors an explicit tooltip distinct from the accessible name", () => {
    render(<IconButton icon={icon} label="More actions" title="Open menu" />);

    const button = screen.getByRole("button", { name: "More actions" });
    expect(button.getAttribute("title")).toBe("Open menu");
  });

  it("forwards Button props such as variant and click handling", () => {
    const clicks: string[] = [];
    render(
      <IconButton
        icon={icon}
        label="Delete"
        onClick={() => clicks.push("x")}
        variant="ghost"
      />
    );

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.className).toContain("bg-transparent");
    button.click();
    expect(clicks).toEqual(["x"]);
  });
});
