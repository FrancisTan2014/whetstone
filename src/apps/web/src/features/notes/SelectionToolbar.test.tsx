// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SelectionToolbar } from "./SelectionToolbar";
import type { NoteTemplateDto } from "@whetstone/contracts";

const templates: ReadonlyArray<NoteTemplateDto> = [
  {
    fields: [{ id: "meaning", label: "Meaning", type: "long_text" }],
    id: "vocabulary",
    name: "Vocabulary"
  },
  {
    fields: [{ id: "noticed", label: "Noticed", type: "long_text" }],
    id: "expression",
    name: "Expression"
  },
  {
    fields: [{ id: "thought", label: "Thought", type: "long_text" }],
    id: "thought",
    name: "Thought"
  }
];

function renderToolbar(
  overrides: {
    anchorRect?: DOMRect;
    onClose?: () => void;
    onConfirm?: () => void;
    onLookup?: () => void;
    onSelectTemplate?: (templateId: string) => void;
    selectedTemplateId?: string;
  } = {}
): {
  onClose: () => void;
  onConfirm: () => void;
  onLookup: () => void;
  onSelectTemplate: (templateId: string) => void;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onClose = overrides.onClose ?? vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  const onLookup = overrides.onLookup ?? vi.fn();
  const onSelectTemplate = overrides.onSelectTemplate ?? vi.fn();
  const user = userEvent.setup();

  render(
    <SelectionToolbar
      anchorRect={overrides.anchorRect}
      onClose={onClose}
      onConfirm={onConfirm}
      onLookup={onLookup}
      onSelectTemplate={onSelectTemplate}
      prefersReducedMotion={false}
      selectedTemplateId={overrides.selectedTemplateId ?? "vocabulary"}
      templates={templates}
    />
  );

  return { onClose, onConfirm, onLookup, onSelectTemplate, user };
}

afterEach(() => {
  cleanup();
});

describe("SelectionToolbar", () => {
  it("marks the preselected template as pressed and the others as not", () => {
    renderToolbar({ selectedTemplateId: "expression" });

    expect(screen.getByRole("button", { name: "Expression" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: "Vocabulary" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("switches the template when a hued option is pressed", async () => {
    const { onSelectTemplate, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Thought" }));

    expect(onSelectTemplate).toHaveBeenCalledWith("thought");
  });

  it("confirms to open the editor", async () => {
    const { onConfirm, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Add note" }));

    expect(onConfirm).toHaveBeenCalled();
  });

  it("triggers a lookup without opening the editor", async () => {
    const { onConfirm, onLookup, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Look up" }));

    expect(onLookup).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("dismisses when closed", async () => {
    const { onClose, user } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("anchors to the selection rect when one is given", () => {
    renderToolbar({ anchorRect: { bottom: 40, left: 12 } as DOMRect });

    const toolbar = screen.getByRole("toolbar", { name: "Annotate selection" });
    expect(toolbar.style.left).toBe("12px");
    expect(toolbar.style.top).toBe("40px");
  });

  it("renders without a fixed position when no rect is given", () => {
    renderToolbar();

    const toolbar = screen.getByRole("toolbar", { name: "Annotate selection" });
    expect(toolbar.style.left).toBe("");
    expect(toolbar.style.top).toBe("");
  });
});
