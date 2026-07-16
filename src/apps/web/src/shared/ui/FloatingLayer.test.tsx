// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FloatingLayerProvider, useFloatingLayerContainer } from "./FloatingLayer";

afterEach(() => {
  cleanup();
});

// Reports the container the getter resolves to by tagging it, so a test can assert which node the
// floating surfaces would portal into without rendering a real editor.
function Probe({ label }: { readonly label: string }): React.JSX.Element {
  const container = useFloatingLayerContainer();
  const node = container();
  return (
    <button
      onClick={() => {
        node.setAttribute("data-resolved", label);
      }}
      type="button"
    >
      resolve {label}
    </button>
  );
}

describe("FloatingLayer", () => {
  it("defaults to the document body when no provider wraps the consumer", () => {
    render(<Probe label="default" />);

    screen.getByRole("button", { name: "resolve default" }).click();

    expect(document.body.getAttribute("data-resolved")).toBe("default");
  });

  it("resolves to a provider-supplied node so surfaces portal inside it", () => {
    const host = document.createElement("div");
    host.id = "floating-host";
    document.body.appendChild(host);

    render(
      <FloatingLayerProvider container={host}>
        <Probe label="hosted" />
      </FloatingLayerProvider>
    );

    screen.getByRole("button", { name: "resolve hosted" }).click();

    expect(host.getAttribute("data-resolved")).toBe("hosted");
    expect(document.body.getAttribute("data-resolved")).not.toBe("hosted");
  });

  it("falls back to the body while the provider's host is still null", () => {
    render(
      <FloatingLayerProvider container={null}>
        <Probe label="pending" />
      </FloatingLayerProvider>
    );

    screen.getByRole("button", { name: "resolve pending" }).click();

    expect(document.body.getAttribute("data-resolved")).toBe("pending");
  });

  it("keeps the getter stable across an unrelated re-render (memo cache hit)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const getters: Array<() => HTMLElement> = [];

    function Recorder(): React.JSX.Element {
      getters.push(useFloatingLayerContainer());
      return <span>recorded</span>;
    }

    function Harness(): React.JSX.Element {
      const [tick, setTick] = useState(0);
      return (
        <FloatingLayerProvider container={host}>
          <button onClick={() => setTick(tick + 1)} type="button">
            tick {tick}
          </button>
          <Recorder />
        </FloatingLayerProvider>
      );
    }

    render(<Harness />);
    // Re-render with the SAME container node but a changed sibling trigger: the memoized getter must be
    // reused (referential stability keeps the BubbleMenu from looping its updateOptions transaction).
    fireEvent.click(screen.getByRole("button", { name: "tick 0" }));

    expect(getters.length).toBeGreaterThanOrEqual(2);
    expect(getters[0]).toBe(getters[getters.length - 1]);
  });
});
