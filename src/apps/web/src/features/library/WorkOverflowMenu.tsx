import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import type { WorkListItemDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { libraryMenuClassNames as cx } from "./libraryMenu.tokens";

export type WorkOverflowMenuProps = Readonly<{
  item: WorkListItemDto;
  // Authored (owned) Works edit in the rich editor; imported/manual Works manage their content in the
  // content panel. Exactly one of those two entries shows per Work.
  authored: boolean;
  // A Work enrolled for recitation opens in Recite; an un-enrolled one offers the enrolment declaration.
  // Library shows no recitation phase/passage/due state — Recite owns all ongoing maintenance (#640).
  enrolled: boolean;
  // The enrolment for THIS Work is in flight, so its "I can recite this" entry is disabled to prevent a
  // double-submit while the plan is created.
  enrolling: boolean;
  onRecite: () => void;
  onManageContent: () => void;
  onDelete: () => void;
}>;

// One Work card carries exactly one persistent primary action (Read/Continue) plus this overflow menu
// (#640): the former visible row of per-Work actions collapses to a single 44px trigger whose accessible
// name names the Work. The menu holds only the actions valid for that Work, in a fixed order — recite,
// notes, edit-or-manage, then the destructive delete visually separated — and reaches real menu
// semantics (roles, keyboard, Escape, outside dismissal, focus restored to the trigger, viewport-aware
// placement) through Radix. Navigations are anchors so they route on select and close the menu.
export function WorkOverflowMenu({
  item,
  authored,
  enrolled,
  enrolling,
  onRecite,
  onManageContent,
  onDelete
}: WorkOverflowMenuProps): React.JSX.Element {
  const workEntryId = item.work.entryId;
  const encoded = encodeURIComponent(workEntryId);

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          aria-label={`More actions for ${item.work.title}`}
          className="min-w-11 px-2"
          variant="ghost"
        >
          <span aria-hidden="true">⋯</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={cx.content} sideOffset={4}>
          {enrolled ? (
            <DropdownMenu.Item asChild className={cx.item}>
              <a href={`#/recite`}>Open in Recite</a>
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item className={cx.item} disabled={enrolling} onSelect={onRecite}>
              I can recite this
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Item asChild className={cx.item}>
            <a href={`#/notes?work=${encoded}`}>View notes</a>
          </DropdownMenu.Item>

          {authored ? (
            <DropdownMenu.Item asChild className={cx.item}>
              <a href={`#/write?work=${encoded}`}>Edit in Writing</a>
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item className={cx.item} onSelect={onManageContent}>
              Manage content
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Separator className={cx.separator} />

          <DropdownMenu.Item className={cx.destructiveItem} onSelect={onDelete}>
            Delete work
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
