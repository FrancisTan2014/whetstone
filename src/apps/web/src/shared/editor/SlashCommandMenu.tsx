import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";

import type { BlockCommand } from "./blockCommands.js";
import { slashMenuClassNames } from "./SlashCommandMenu.tokens.js";

export interface SlashCommandMenuProps {
  readonly items: readonly BlockCommand[];
  readonly query: string;
  readonly onSelect: (command: BlockCommand) => void;
}

export interface SlashCommandMenuHandle {
  /** Handle an editor keystroke while the menu is open; returns true when consumed. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

function scrollOptionIntoView(element: HTMLElement | null): void {
  if (element !== null && typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "nearest" });
  }
}

// The caret-anchored command list. It renders as an ARIA listbox but never takes focus — the editor
// keeps the caret, so the parent extension forwards Up/Down/Enter here and this component reports
// whether it consumed the key. Selection also works by pointer/touch without moving focus. The active
// option is tracked in a ref as well as state so a synchronous keystroke sees the latest index even
// before React re-renders, and it resets to the top whenever the filtered result set changes.
export const SlashCommandMenu = forwardRef<SlashCommandMenuHandle, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, onSelect, query }, ref): React.JSX.Element {
    const baseId = useId();
    const [activeIndex, setActiveIndex] = useState(0);
    const activeIndexRef = useRef(0);
    const optionRefs = useRef<Array<HTMLElement | null>>([]);
    const signature = useMemo(() => items.map((item) => item.id).join("|"), [items]);

    const moveActive = (index: number): void => {
      activeIndexRef.current = index;
      setActiveIndex(index);
    };

    useEffect(() => {
      moveActive(0);
    }, [signature]);

    useEffect(() => {
      scrollOptionIntoView(optionRefs.current[activeIndex] ?? null);
    }, [activeIndex]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event) => {
          const count = items.length;

          if (count === 0) {
            return false;
          }

          if (event.key === "ArrowDown") {
            moveActive((activeIndexRef.current + 1) % count);
            return true;
          }

          if (event.key === "ArrowUp") {
            moveActive((activeIndexRef.current - 1 + count) % count);
            return true;
          }

          if (event.key === "Enter") {
            const command = items[activeIndexRef.current];

            // The reset effect re-clamps activeIndexRef to 0 whenever the item set changes, so a
            // non-empty list (count > 0 above) always has a command at the active index; this guard
            // only covers a sub-render-frame race and is unreachable from the public behavior.
            /* v8 ignore next 3 */
            if (command === undefined) {
              return true;
            }

            onSelect(command);
            return true;
          }

          return false;
        }
      }),
      [items, onSelect]
    );

    const optionId = (command: BlockCommand): string => `${baseId}-${command.id}`;
    const activeCommand = items[activeIndex];
    const announcement =
      items.length === 0
        ? query === ""
          ? "No commands."
          : `No commands match ${query}.`
        : `${String(items.length)} command${items.length === 1 ? "" : "s"} available.` +
          (activeCommand === undefined ? "" : ` ${activeCommand.label} selected.`);

    return (
      <div className={slashMenuClassNames.root}>
        <div aria-live="polite" className={slashMenuClassNames.status} role="status">
          {announcement}
        </div>
        {items.length === 0 ? (
          <p className={slashMenuClassNames.empty}>No commands</p>
        ) : (
          <ul
            aria-activedescendant={
              activeCommand === undefined ? undefined : optionId(activeCommand)
            }
            aria-label="Block commands"
            className={slashMenuClassNames.list}
            role="listbox"
            tabIndex={-1}
          >
            {items.map((command, index) => {
              const active = index === activeIndex;

              return (
                <li
                  aria-selected={active}
                  className={
                    active
                      ? `${slashMenuClassNames.option} ${slashMenuClassNames.activeOption}`
                      : slashMenuClassNames.option
                  }
                  id={optionId(command)}
                  key={command.id}
                  onPointerDown={(event) => {
                    // Keep the caret in the editor: never let the pointer move focus to the menu.
                    event.preventDefault();
                    onSelect(command);
                  }}
                  onPointerEnter={() => moveActive(index)}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  role="option"
                >
                  <span className={slashMenuClassNames.optionLabel}>{command.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }
);
