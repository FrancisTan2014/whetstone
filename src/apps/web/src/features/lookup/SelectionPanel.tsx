import * as Popover from "@radix-ui/react-popover";
import { X } from "lucide-react";

import { Sheet } from "../../shared/ui/Sheet";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";

export type SelectionPanelProps = Readonly<{
  anchorRect?: DOMRect | undefined;
  children: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}>;

// One selection-anchored shell for the independent dictionary and AI surfaces. Radix owns
// collision handling, keyboard/focus, and dismissal; the shared Sheet owns the mobile layout.
export function SelectionPanel({
  anchorRect,
  children,
  onOpenChange,
  open,
  title
}: SelectionPanelProps): React.JSX.Element {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  if (!isDesktop) {
    return (
      <Sheet onOpenChange={onOpenChange} open={open} side="bottom" title={title}>
        <div className="lookupPanel">{children}</div>
      </Sheet>
    );
  }

  const anchorStyle: React.CSSProperties =
    anchorRect === undefined
      ? { left: "50%", position: "fixed", top: "50%" }
      : {
          height: anchorRect.height,
          left: anchorRect.left,
          position: "fixed",
          top: anchorRect.top,
          width: anchorRect.width
        };
  return (
    <Popover.Root onOpenChange={onOpenChange} open={open}>
      <Popover.Anchor aria-hidden className="lookupAnchor" style={anchorStyle} />
      <Popover.Portal>
        <Popover.Content
          align="start"
          aria-label={title}
          className="lookupPopover"
          collisionPadding={12}
          side="bottom"
          sideOffset={8}
          style={{
            maxHeight: "min(30rem, var(--radix-popover-content-available-height, 72vh))"
          }}
        >
          <div className="lookupPopoverChrome">
            <Popover.Close aria-label="Close" className="lookupClose">
              <X aria-hidden size={20} strokeWidth={1.75} />
            </Popover.Close>
          </div>
          <div className="lookupPanel">{children}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
