// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "./ToastProvider";
import { ToastViewport } from "./ToastViewport";

function Enqueue(): React.JSX.Element {
  const { error, success } = useToast();

  return (
    <div>
      <button onClick={() => success("Imported book")} type="button">
        do-success
      </button>
      <button onClick={() => error("Import failed")} type="button">
        do-error
      </button>
    </div>
  );
}

function renderViewport(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <Enqueue />
      <ToastViewport />
    </ToastProvider>
  );
}

function mockReducedMotion(prefersReduce: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: query.includes("reduce") ? prefersReduce : false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;

  return () => {
    window.matchMedia = original;
  };
}

afterEach(() => {
  cleanup();
});

describe("ToastViewport", () => {
  it("mounts a single labelled live region", () => {
    renderViewport();

    expect(screen.getByRole("region", { name: "Notifications" })).toBeDefined();
  });

  it("renders a success politely and an error assertively, stacked", () => {
    renderViewport();

    fireEvent.click(screen.getByText("do-success"));
    fireEvent.click(screen.getByText("do-error"));

    expect(screen.getByRole("status").textContent).toContain("Imported book");
    expect(screen.getByRole("alert").textContent).toContain("Import failed");
  });

  it("removes a toast when its dismiss button is pressed", () => {
    renderViewport();

    fireEvent.click(screen.getByText("do-success"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByText("Imported book")).toBeNull();
  });

  it("still shows the toast under reduced motion", () => {
    const restore = mockReducedMotion(true);

    try {
      renderViewport();
      fireEvent.click(screen.getByText("do-success"));

      expect(screen.getByRole("status").textContent).toContain("Imported book");
    } finally {
      restore();
    }
  });
});
