// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChapterPager } from "./ChapterPager";
import type { ReaderStructure } from "./readerModel";

function structure(count: number): ReaderStructure {
  return {
    units: Array.from({ length: count }, (_, index) => ({
      blockCount: 1,
      entryId: `u-${index}`,
      orderIndex: index,
      title: `Chapter ${index + 1}`
    })),
    workEntryId: "w-1"
  };
}

afterEach(cleanup);

describe("ChapterPager", () => {
  it("renders nothing for a single-unit work", () => {
    const { container } = render(
      <ChapterPager activeUnitIndex={0} onSelectUnit={vi.fn()} structure={structure(1)} />
    );
    expect(container.querySelector(".readerPager")).toBeNull();
  });

  it("hides Previous on the first unit and shows Next", () => {
    render(<ChapterPager activeUnitIndex={0} onSelectUnit={vi.fn()} structure={structure(3)} />);
    expect(screen.queryByText("← Previous")).toBeNull();
    expect(screen.getByText("Next →")).toBeDefined();
  });

  it("hides Next on the last unit and shows Previous", () => {
    render(<ChapterPager activeUnitIndex={2} onSelectUnit={vi.fn()} structure={structure(3)} />);
    expect(screen.queryByText("Next →")).toBeNull();
    expect(screen.getByText("← Previous")).toBeDefined();
  });

  it("shows both with adjacent titles in the middle and selects index ±1", async () => {
    const onSelectUnit = vi.fn();
    const user = userEvent.setup();
    render(
      <ChapterPager activeUnitIndex={1} onSelectUnit={onSelectUnit} structure={structure(3)} />
    );

    expect(screen.getByText("Chapter 1")).toBeDefined();
    expect(screen.getByText("Chapter 3")).toBeDefined();

    await user.click(screen.getByText("Next →"));
    await user.click(screen.getByText("← Previous"));
    expect(onSelectUnit).toHaveBeenNthCalledWith(1, 2);
    expect(onSelectUnit).toHaveBeenNthCalledWith(2, 0);
  });
});
