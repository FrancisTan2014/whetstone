import { useRef } from "react";

export type WorkspaceTab = Readonly<{ controls: string; id: string; label: string }>;

type NoteWorkspaceTabsProps = Readonly<{
  activeId: string;
  label: string;
  onActivate: (id: string) => void;
  tabs: ReadonlyArray<WorkspaceTab>;
}>;

// The Note|Cards mode bar (#700): a real ARIA tablist with roving tabindex, arrow-key navigation, a
// visible selected state (text weight plus the accent underline), and 44px targets. Activation is
// automatic — arrowing to or clicking a tab selects it — but the parent owns the selection and may refuse
// a change (the dirty-Reference gate keeps the learner in Note), so this control only reports intent
// through `onActivate` and never assumes the mode switched.
export function NoteWorkspaceTabs({
  activeId,
  label,
  onActivate,
  tabs
}: NoteWorkspaceTabsProps): React.JSX.Element {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTab(index: number): void {
    const target = tabs[index];
    if (target === undefined) {
      return;
    }
    buttons.current[index]?.focus();
    onActivate(target.id);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        focusTab((index + 1) % tabs.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        focusTab((index - 1 + tabs.length) % tabs.length);
        break;
      case "Home":
        event.preventDefault();
        focusTab(0);
        break;
      case "End":
        event.preventDefault();
        focusTab(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div aria-label={label} className="noteWorkspaceTabs" role="tablist">
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        return (
          <button
            aria-controls={tab.controls}
            aria-selected={selected}
            className="noteWorkspaceTab min-h-11"
            id={`${tab.id}-tab`}
            key={tab.id}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
