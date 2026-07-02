// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrontMatterNotice } from "./FrontMatterNotice";
import type { ReaderStructure } from "./readerModel";

const withFrontMatter: ReaderStructure = {
  units: [
    { blockCount: 1, entryId: "cover", hasSubstantiveText: false, orderIndex: 0 },
    { blockCount: 4, entryId: "body", hasSubstantiveText: true, orderIndex: 1 }
  ],
  workEntryId: "work-1"
};

afterEach(cleanup);

describe("FrontMatterNotice", () => {
  it("labels a front-matter unit and jumps to the first substantive unit (#394)", async () => {
    const onSelectUnit = vi.fn();
    render(
      <FrontMatterNotice
        activeUnitIndex={0}
        onSelectUnit={onSelectUnit}
        structure={withFrontMatter}
      />
    );

    expect(screen.getByLabelText("Front matter")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /start reading/i }));

    expect(onSelectUnit).toHaveBeenCalledWith(1);
  });

  it("renders nothing on a substantive unit", () => {
    const { container } = render(
      <FrontMatterNotice activeUnitIndex={1} onSelectUnit={vi.fn()} structure={withFrontMatter} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the active unit index is out of range", () => {
    const { container } = render(
      <FrontMatterNotice activeUnitIndex={9} onSelectUnit={vi.fn()} structure={withFrontMatter} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when every unit is front matter (no substantive target)", () => {
    const allFrontMatter: ReaderStructure = {
      units: [{ blockCount: 1, entryId: "cover", hasSubstantiveText: false, orderIndex: 0 }],
      workEntryId: "work-fm-only"
    };

    const { container } = render(
      <FrontMatterNotice activeUnitIndex={0} onSelectUnit={vi.fn()} structure={allFrontMatter} />
    );

    expect(container.firstChild).toBeNull();
  });
});
