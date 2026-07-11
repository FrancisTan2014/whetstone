import type { Editor } from "@tiptap/core";
import * as Popover from "@radix-ui/react-popover";
import { useId, useRef, useState } from "react";

import { Button } from "../ui/Button.js";
import { normalizeEditorLinkHref } from "./editorDocument.js";
import { formattingMenuClassNames } from "./EditorFormattingMenu.tokens.js";

const LINK_ERROR = "Use an http, https, mailto, anchor, or root-relative link.";

interface MarkDefinition {
  readonly label: string;
  readonly name: string;
}

// Bold, Italic, and Inline code are the inline marks the document boundary already round-trips; block
// transforms stay on the slash menu (#588).
const MARKS: readonly MarkDefinition[] = [
  { label: "Bold", name: "bold" },
  { label: "Italic", name: "italic" },
  { label: "Inline code", name: "code" }
];

export interface EditorFormattingMenuProps {
  readonly editor: Editor;
  /** Close the toolbar and return focus to the selected text (Escape). */
  readonly onEscape: () => void;
}

// The contextual formatting toolbar rendered inside Tiptap's BubbleMenu. It exposes toolbar semantics
// with roving keyboard focus (one tab stop; Arrow/Home/End move between controls) and derives every
// pressed/disabled state from the live selection. Applying a mark re-focuses the editor first, so the
// selection is preserved and another command can follow. Escape is handled here only when the link
// form is closed — Radix owns Escape while the form is open.
export function EditorFormattingMenu({
  editor,
  onEscape
}: EditorFormattingMenuProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const controlCount = MARKS.length + 1;

  const focusControl = (index: number): void => {
    const next = (index + controlCount) % controlCount;
    setActiveIndex(next);
    // The roving tab stops are exactly the toolbar's direct-child buttons (marks + link trigger); the
    // link form's own buttons are nested inside the popover content, so they are never included here.
    toolbarRef.current?.querySelectorAll<HTMLButtonElement>(":scope > button")[next]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusControl(activeIndex + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusControl(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        focusControl(0);
        break;
      case "End":
        event.preventDefault();
        focusControl(controlCount - 1);
        break;
      case "Escape":
        if (!linkOpen) {
          event.preventDefault();
          onEscape();
        }
        break;
      default:
        break;
    }
  };

  return (
    <div
      aria-label="Text formatting"
      aria-orientation="horizontal"
      className={formattingMenuClassNames.toolbar}
      onKeyDown={handleKeyDown}
      ref={toolbarRef}
      role="toolbar"
    >
      {MARKS.map((mark, index) => {
        const active = editor.isActive(mark.name);

        return (
          <Button
            aria-label={mark.label}
            aria-pressed={active}
            className={formattingMenuClassNames.action}
            disabled={!editor.can().toggleMark(mark.name)}
            key={mark.name}
            onClick={() => editor.chain().focus().toggleMark(mark.name).run()}
            onFocus={() => setActiveIndex(index)}
            size="sm"
            tabIndex={activeIndex === index ? 0 : -1}
            variant={active ? "secondary" : "ghost"}
          >
            {mark.label}
          </Button>
        );
      })}
      <LinkControl
        editor={editor}
        onFocus={() => setActiveIndex(MARKS.length)}
        onOpenChange={setLinkOpen}
        open={linkOpen}
        tabIndex={activeIndex === MARKS.length ? 0 : -1}
      />
    </div>
  );
}

interface LinkControlProps {
  readonly editor: Editor;
  readonly onFocus: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly tabIndex: number;
}

// The Link control: a toolbar toggle that opens a compact anchored form (Radix Popover, no portal so
// focus stays within the BubbleMenu element). The form prefills from the active link and applies or
// removes it through the shared safe-link normalization; an unsafe or malformed URL surfaces an error
// without closing the form or losing the selection.
function LinkControl({
  editor,
  onFocus,
  onOpenChange,
  open,
  tabIndex
}: LinkControlProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const errorId = useId();
  const active = editor.isActive("link");
  const canLink = editor.can().toggleMark("link");

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      const href = editor.getAttributes("link")["href"];
      setValue(typeof href === "string" ? href : "");
      setError(undefined);
    }

    onOpenChange(next);
  };

  const removeLink = (): void => {
    editor.chain().focus().unsetMark("link", { extendEmptyMarkRange: true }).run();
    onOpenChange(false);
  };

  const applyLink = (): void => {
    const trimmed = value.trim();

    if (trimmed === "") {
      removeLink();
      return;
    }

    const href = normalizeEditorLinkHref(trimmed);
    if (href === undefined) {
      setError(LINK_ERROR);
      return;
    }

    editor.chain().focus().setMark("link", { href }).run();
    onOpenChange(false);
  };

  return (
    <Popover.Root onOpenChange={handleOpenChange} open={open}>
      <Popover.Trigger asChild>
        <Button
          aria-haspopup="dialog"
          aria-label="Link"
          aria-pressed={active}
          className={formattingMenuClassNames.action}
          disabled={!canLink}
          onFocus={onFocus}
          size="sm"
          tabIndex={tabIndex}
          variant={active ? "secondary" : "ghost"}
        >
          Link
        </Button>
      </Popover.Trigger>
      <Popover.Content
        aria-label="Link URL"
        className={formattingMenuClassNames.linkForm}
        side="bottom"
        sideOffset={8}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <label className={formattingMenuClassNames.linkField}>
            <span className="sr-only">Link URL</span>
            <input
              aria-describedby={error === undefined ? undefined : errorId}
              aria-invalid={error === undefined ? undefined : true}
              aria-label="Link URL"
              className={formattingMenuClassNames.linkInput}
              inputMode="url"
              onChange={(event) => setValue(event.currentTarget.value)}
              placeholder="https://example.com"
              type="text"
              value={value}
            />
          </label>
          {error === undefined ? null : (
            <p className={formattingMenuClassNames.linkError} id={errorId} role="alert">
              {error}
            </p>
          )}
          <div className={formattingMenuClassNames.linkActions}>
            <Button size="sm" type="submit" variant="secondary">
              Apply link
            </Button>
            <Button onClick={removeLink} size="sm" type="button" variant="ghost">
              Remove link
            </Button>
          </div>
        </form>
      </Popover.Content>
    </Popover.Root>
  );
}
