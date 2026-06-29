// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast, useToastQueue } from "./ToastProvider";

// A harness that drives the queue through both public hooks and renders the raw queue (no
// framer-motion) so enqueue/dismiss/auto-dismiss are asserted deterministically.
function Harness(): React.JSX.Element {
  const { error, success } = useToast();
  const { dismiss, toasts } = useToastQueue();

  return (
    <div>
      <button onClick={() => success("Saved")} type="button">
        add-success
      </button>
      <button onClick={() => error("Failed")} type="button">
        add-error
      </button>
      <ul>
        {toasts.map((toast) => (
          <li data-intent={toast.intent} key={toast.id}>
            {toast.message}
            <button onClick={() => dismiss(toast.id)} type="button">
              dismiss-{toast.id}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderHarness(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <Harness />
    </ToastProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("queues a success and an error without overlapping", () => {
    renderHarness();

    fireEvent.click(screen.getByText("add-success"));
    fireEvent.click(screen.getByText("add-error"));

    const intents = screen.getAllByRole("listitem").map((item) => item.getAttribute("data-intent"));
    expect(intents).toEqual(["success", "error"]);
    expect(screen.getByText("Saved")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
  });

  it("auto-dismisses a toast after its timeout", () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByText("add-success"));
    expect(screen.getByText("Saved")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("dismisses immediately and cancels the pending auto-dismiss", () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByText("add-success"));
    fireEvent.click(screen.getByText(/^dismiss-/));
    expect(screen.queryByText("Saved")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("clears pending timers when the provider unmounts", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = renderHarness();

    fireEvent.click(screen.getByText("add-success"));
    clearSpy.mockClear();
    unmount();

    expect(clearSpy).toHaveBeenCalled();
  });

  it("collapses a duplicate identical toast instead of stacking", () => {
    renderHarness();

    fireEvent.click(screen.getByText("add-error"));
    fireEvent.click(screen.getByText("add-error"));

    // Two identical errors (e.g. one per spanned block on a cross-block selection) show as one (#258).
    expect(screen.getAllByText("Failed")).toHaveLength(1);
  });

  it("throws when the hook is used outside a provider", () => {
    function Outside(): React.JSX.Element {
      useToast();
      return <div />;
    }

    expect(() => render(<Outside />)).toThrow("within a ToastProvider");
  });
});
