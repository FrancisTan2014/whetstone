// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toast } from "./Toast";

afterEach(() => {
  cleanup();
});

describe("Toast", () => {
  it("announces a success politely", () => {
    render(
      <Toast
        intent="success"
        message="Note saved."
        onDismiss={vi.fn()}
        prefersReducedMotion={false}
      />
    );

    expect(screen.getByRole("status").textContent).toContain("Note saved.");
  });

  it("announces an error assertively under reduced motion", () => {
    render(
      <Toast intent="error" message="Save failed." onDismiss={vi.fn()} prefersReducedMotion />
    );

    expect(screen.getByRole("alert").textContent).toContain("Save failed.");
  });

  it("dismisses from the close button", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <Toast intent="success" message="Saved." onDismiss={onDismiss} prefersReducedMotion={false} />
    );

    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
