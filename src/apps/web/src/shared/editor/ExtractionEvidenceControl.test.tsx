// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PdfExtractionEvidenceItemDto } from "@whetstone/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ExtractionEvidenceControl } from "./ExtractionEvidenceControl";

function evidence(
  overrides: Partial<PdfExtractionEvidenceItemDto> = {}
): PdfExtractionEvidenceItemDto {
  return {
    blockId: "block-1",
    confidence: 0.4,
    corrected: false,
    label: "text",
    ocrEngine: null,
    ocrLanguage: null,
    page: 3,
    reviewSuggested: true,
    ...overrides
  };
}

afterEach(() => {
  cleanup();
});

describe("ExtractionEvidenceControl", () => {
  it("renders a collapsed keyboard-operable trigger by default", () => {
    render(<ExtractionEvidenceControl evidence={evidence()} />);

    const trigger = screen.getByRole("button", { name: "Review extraction" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("discloses page, label, and a below-threshold confidence band on activation", async () => {
    const user = userEvent.setup();
    render(<ExtractionEvidenceControl evidence={evidence({ label: "list_item" })} />);

    await user.click(screen.getByRole("button", { name: "Review extraction" }));

    const panel = screen.getByRole("group");
    expect(
      screen.getByRole("button", { name: "Review extraction" }).getAttribute("aria-expanded")
    ).toBe("true");
    expect(panel.textContent).toContain("Page");
    expect(panel.textContent).toContain("3");
    expect(panel.textContent).toContain("list_item");
    expect(panel.textContent).toContain("Review suggested");
    expect(panel.textContent).toContain("Extraction evidence");
  });

  it("labels an at-or-above-threshold confidence High and a null confidence Not reported", async () => {
    const user = userEvent.setup();
    render(<ExtractionEvidenceControl evidence={evidence({ confidence: 0.75 })} />);
    await user.click(screen.getByRole("button", { name: "Review extraction" }));
    expect(screen.getByRole("group").textContent).toContain("High");

    cleanup();
    render(<ExtractionEvidenceControl evidence={evidence({ confidence: null })} />);
    await user.click(screen.getByRole("button", { name: "Review extraction" }));
    expect(screen.getByRole("group").textContent).toContain("Not reported");
  });

  it("shows OCR provenance only when present", async () => {
    const user = userEvent.setup();
    render(
      <ExtractionEvidenceControl
        evidence={evidence({ ocrEngine: "tesseract-5.3", ocrLanguage: "eng" })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Review extraction" }));

    const panel = screen.getByRole("group");
    expect(panel.textContent).toContain("tesseract-5.3");
    expect(panel.textContent).toContain("eng");
    expect(panel.textContent).toContain("OCR engine");
  });

  it("omits OCR rows for a native (non-OCR) block", async () => {
    const user = userEvent.setup();
    render(<ExtractionEvidenceControl evidence={evidence()} />);

    await user.click(screen.getByRole("button", { name: "Review extraction" }));

    const panel = screen.getByRole("group");
    expect(panel.textContent).not.toContain("OCR engine");
    expect(panel.textContent).not.toContain("OCR language");
  });

  it("reframes the disclosure as corrected while retaining the evidence", async () => {
    const user = userEvent.setup();
    render(<ExtractionEvidenceControl evidence={evidence({ corrected: true })} />);

    await user.click(screen.getByRole("button", { name: "Review extraction" }));

    const panel = screen.getByRole("group");
    expect(panel.textContent).toContain("Corrected — original extraction evidence");
    expect(panel.textContent).toContain("Page");
  });

  it("toggles by keyboard (focus + Enter)", async () => {
    const user = userEvent.setup();
    render(<ExtractionEvidenceControl evidence={evidence()} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review extraction" }));

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("group")).not.toBeNull();

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("group")).toBeNull();
  });
});
