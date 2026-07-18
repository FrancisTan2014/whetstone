import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import type { Ref } from "react";

import { IconButton } from "../../shared/ui/Button";
import { notesMenuClassNames as cx } from "./notesMenu.tokens";

export type NotesOverflowMenuProps = Readonly<{
  // While an import is ingesting the trigger is disabled, matching the former inline Import button, so a
  // second import cannot start mid-ingest; focus returns to the trigger once the panel closes.
  busy: boolean;
  onImport: () => void;
  // The trigger element, so the page can restore focus here after a cancelled import.
  triggerRef: Ref<HTMLButtonElement>;
}>;

// The Notes header keeps exactly one persistent primary action (New note); every secondary action lives
// behind this overflow menu (#641 "secondary actions use the owning overflow/menu"). Today it holds the
// single Import action, reached through Radix for real menu semantics — role=menu/menuitem, arrow/Enter/
// Space/Escape, outside dismissal, and focus restored to the trigger on close. The icon-only trigger goes
// through IconButton so it carries a specific accessible name, a hover tooltip, visible focus, and a 44px
// target without re-declaring them.
export function NotesOverflowMenu({
  busy,
  onImport,
  triggerRef
}: NotesOverflowMenuProps): React.JSX.Element {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <IconButton
          disabled={busy}
          icon={<MoreHorizontal aria-hidden="true" size={20} strokeWidth={1.75} />}
          label="More note actions"
          ref={triggerRef}
          variant="ghost"
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={cx.content} sideOffset={4}>
          <DropdownMenu.Item className={cx.item} onSelect={onImport}>
            Import
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
