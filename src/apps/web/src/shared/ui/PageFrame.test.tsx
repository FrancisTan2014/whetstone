// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { PageFrame } from "./PageFrame";

afterEach(() => {
  cleanup();
});

function renderFrame(ui: React.ReactNode): HTMLElement {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  return container;
}

function frameSection(container: HTMLElement): HTMLElement {
  const section = container.querySelector("section");
  if (section === null) {
    throw new Error("PageFrame did not render a section");
  }
  return section;
}

describe("PageFrame", () => {
  it("renders the title as the single H1 and labels the region with it", () => {
    const container = renderFrame(
      <PageFrame title="Today">
        <p>content</p>
      </PageFrame>
    );

    const heading = screen.getByRole("heading", { level: 1, name: "Today" });
    expect(heading.className).toContain("font-semibold");
    // The 28px/34px title scale (#641) — arbitrary-value utilities, not text-2xl.
    expect(heading.className).toContain("text-[1.75rem]");
    expect(heading.className).toContain("leading-[2.125rem]");
    // The region is labelled by the H1 it owns, so the page never re-declares aria-labelledby.
    expect(frameSection(container).getAttribute("aria-labelledby")).toBe(heading.id);
    expect(screen.getByText("content")).not.toBeNull();
  });

  it("applies the focused width by default and the collection width on request", () => {
    const focused = renderFrame(
      <PageFrame title="Today">
        <p>a</p>
      </PageFrame>
    );
    expect(frameSection(focused).className).toContain("max-w-[42rem]");

    const collection = renderFrame(
      <PageFrame title="Library" width="collection">
        <p>b</p>
      </PageFrame>
    );
    expect(frameSection(collection).className).toContain("max-w-[64rem]");
  });

  it("uses responsive gutters and top spacing", () => {
    const container = renderFrame(
      <PageFrame title="Today">
        <p>a</p>
      </PageFrame>
    );
    const section = frameSection(container);
    // 16px gutters below 768px, 24px at and above; 24px top on mobile, 32px on desktop.
    expect(section.className).toContain("px-4");
    expect(section.className).toContain("md:px-6");
    expect(section.className).toContain("pt-6");
    expect(section.className).toContain("md:pt-8");
  });

  it("renders an optional muted description and omits it when absent", () => {
    renderFrame(
      <PageFrame description="Your deterministic routine board." title="Today">
        <p>a</p>
      </PageFrame>
    );
    const description = screen.getByText("Your deterministic routine board.");
    expect(description.className).toContain("text-text-muted");

    cleanup();
    const withoutCopy = renderFrame(
      <PageFrame title="Today">
        <p>a</p>
      </PageFrame>
    );
    expect(screen.queryByText("Your deterministic routine board.")).toBeNull();
    expect(frameSection(withoutCopy)).toBeDefined();
  });

  it("renders a parent link with a back icon and a 44px target, and omits it when absent", () => {
    renderFrame(
      <PageFrame parentLink={{ label: "Notes", to: "/notes" }} title="Review">
        <p>a</p>
      </PageFrame>
    );

    const link = screen.getByRole("link", { name: "Notes" });
    expect(link.getAttribute("href")).toBe("/notes");
    // A real 44px navigation target, with a decorative Lucide back icon.
    expect(link.className).toContain("min-h-[44px]");
    const icon = link.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");

    cleanup();
    const noParent = renderFrame(
      <PageFrame title="Today">
        <p>a</p>
      </PageFrame>
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(noParent).toBeDefined();
  });

  it("places the single primary action after the heading so focus order is preserved", () => {
    renderFrame(
      <PageFrame primaryAction={<button type="button">Add</button>} title="Library">
        <p>a</p>
      </PageFrame>
    );

    const heading = screen.getByRole("heading", { level: 1, name: "Library" });
    const action = screen.getByRole("button", { name: "Add" });
    // The action follows the title in DOM order, so keyboard focus reaches the heading before it on
    // every viewport even though CSS moves it beside the title on desktop.
    expect(heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    cleanup();
    const noAction = renderFrame(
      <PageFrame title="Library">
        <p>a</p>
      </PageFrame>
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(noAction).toBeDefined();
  });
});
