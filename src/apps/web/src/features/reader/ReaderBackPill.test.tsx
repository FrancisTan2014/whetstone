// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderBackPill } from "./ReaderBackPill";

afterEach(cleanup);

describe("ReaderBackPill", () => {
  it("labels the return control with the origin unit and names it fully for assistive tech", () => {
    render(
      <ReaderBackPill
        onDismiss={vi.fn()}
        onReturn={vi.fn()}
        returnPoint={{ blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" }}
      />
    );

    expect(screen.getByRole("button", { name: "Back to Chapter One" }).textContent).toContain(
      "Back to Chapter One"
    );
  });

  it("falls back to a plain Back label and generic name when the origin unit is untitled", () => {
    render(
      <ReaderBackPill
        onDismiss={vi.fn()}
        onReturn={vi.fn()}
        returnPoint={{ blockEntryId: "b-1", unitEntryId: "u-1" }}
      />
    );

    const control = screen.getByRole("button", { name: "Back to your previous position" });
    expect(control.textContent).toContain("Back");
  });

  it("returns when the main control is tapped", async () => {
    const onReturn = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ReaderBackPill
        onDismiss={onDismiss}
        onReturn={onReturn}
        returnPoint={{ blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Back to Chapter One" }));

    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses without returning when the close control is tapped", async () => {
    const onReturn = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ReaderBackPill
        onDismiss={onDismiss}
        onReturn={onReturn}
        returnPoint={{ blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Dismiss back" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReturn).not.toHaveBeenCalled();
  });
});
