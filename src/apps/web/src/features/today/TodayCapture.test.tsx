// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// The shared CaptureCard is exercised in its own suite; here it is a lightweight stub that exposes the
// two success signals TodayCapture reacts to — a typed save (onCaptured) and an accepted voice clip
// (onVoiceAccepted) — plus a marker so we can assert the full form is mounted only after activation.
vi.mock("../capture/CaptureCard", () => ({
  CaptureCard: ({
    onCaptured,
    onVoiceAccepted,
    presentation
  }: Readonly<{
    onCaptured?: () => void;
    onVoiceAccepted?: () => void;
    presentation?: string;
  }>) => (
    <div data-presentation={presentation}>
      <span>capture form</span>
      <button onClick={() => onCaptured?.()} type="button">
        typed-save
      </button>
      <button onClick={() => onVoiceAccepted?.()} type="button">
        voice-accept
      </button>
    </div>
  )
}));

import { TodayCapture } from "./TodayCapture";

function renderCapture(): void {
  render(
    <MemoryRouter>
      <TodayCapture />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
});

describe("TodayCapture", () => {
  it("shows one compact control and hides the capture form before activation", () => {
    renderCapture();

    expect(screen.getByRole("button", { name: "New diary entry" })).toBeTruthy();
    expect(screen.queryByText("capture form")).toBeNull();
    expect(screen.queryByText("Saved to your diary.")).toBeNull();
  });

  it("opens the shared capture form on activation, sized for Today's compact surface (#678)", async () => {
    renderCapture();

    await userEvent.click(screen.getByRole("button", { name: "New diary entry" }));

    expect(screen.getByText("capture form")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // Today keeps its restrained collapsed feel: the composer mounts in the compact presentation.
    expect(screen.getByText("capture form").closest("[data-presentation]")).toHaveProperty(
      "dataset.presentation",
      "compact"
    );
  });

  it("returns to the compact state with an Open in Diary confirmation after a typed save", async () => {
    renderCapture();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New diary entry" }));
    await user.click(screen.getByRole("button", { name: "typed-save" }));

    expect(screen.getByText("Saved to your diary.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Diary" }).getAttribute("href")).toBe("/diary");
    // The full form collapses again; only the compact control and confirmation remain.
    expect(screen.queryByText("capture form")).toBeNull();
    expect(screen.getByRole("button", { name: "New diary entry" })).toBeTruthy();
  });

  it("returns to the compact confirmation after an accepted voice recording", async () => {
    renderCapture();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New diary entry" }));
    await user.click(screen.getByRole("button", { name: "voice-accept" }));

    expect(screen.getByText("Saved to your diary.")).toBeTruthy();
    expect(screen.queryByText("capture form")).toBeNull();
  });

  it("cancels back to the compact state without a confirmation", async () => {
    renderCapture();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New diary entry" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("capture form")).toBeNull();
    expect(screen.queryByText("Saved to your diary.")).toBeNull();
    expect(screen.getByRole("button", { name: "New diary entry" })).toBeTruthy();
  });

  it("reopens the capture form from the saved state", async () => {
    renderCapture();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New diary entry" }));
    await user.click(screen.getByRole("button", { name: "typed-save" }));
    await user.click(screen.getByRole("button", { name: "New diary entry" }));

    expect(screen.getByText("capture form")).toBeTruthy();
    expect(screen.queryByText("Saved to your diary.")).toBeNull();
  });
});
