import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import { Button } from "../../shared/ui/Button";
import { libraryMenuClassNames as cx } from "./libraryMenu.tokens";

export type LibraryAddMenuProps = Readonly<{
  // While an upload is ingesting the trigger is busy: it shows a spinner, reports aria-busy, and cannot
  // be reopened, so a second file can't be picked mid-ingest.
  busy: boolean;
  // Opens the OS file picker by clicking the page's hidden file input (the one front door for
  // .epub/.pdf/.md), then the existing ingest flow takes over.
  onUploadFile: () => void;
  onAddWorkManually: () => void;
}>;

// The Library header's single **Add** control (#640, #679): one 44px menu for adding source material to the
// Library. It exposes exactly two explicit actions — upload a file or add a Work manually — each opening its
// existing owning flow, duplicating no form here. Creating an authored document now lives in the Write
// destination (#679), not this menu. Radix supplies real menu semantics (role=menu/menuitem,
// arrow/Enter/Space/Escape, typeahead, visible focus, outside dismissal, and focus restored to the trigger
// on close) for free, styled for Day/Night by the shared menu tokens.
export function LibraryAddMenu({
  busy,
  onUploadFile,
  onAddWorkManually
}: LibraryAddMenuProps): React.JSX.Element {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button aria-label="Add" disabled={busy} pending={busy}>
          Add
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={cx.content} sideOffset={4}>
          <DropdownMenu.Item className={cx.item} onSelect={onUploadFile}>
            Upload file
            <span className="text-xs text-text-muted">.epub, .pdf, .md</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={cx.item} onSelect={onAddWorkManually}>
            Add work manually
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
