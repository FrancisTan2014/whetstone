// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button, buttonVariants } from "./Button";

afterEach(() => {
  cleanup();
});

describe("buttonVariants", () => {
  it("maps each variant to its token classes", () => {
    expect(buttonVariants({ variant: "primary" })).toContain("bg-accent");
    expect(buttonVariants({ variant: "secondary" })).toContain("border-border");
    expect(buttonVariants({ variant: "ghost" })).toContain("bg-transparent");
  });

  it("maps each size to its classes and defaults to the medium primary", () => {
    expect(buttonVariants({ size: "sm" })).toContain("h-9");
    expect(buttonVariants({ size: "lg" })).toContain("h-12");
    const fallback = buttonVariants({});
    expect(fallback).toContain("bg-accent");
    expect(fallback).toContain("h-11");
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
});
