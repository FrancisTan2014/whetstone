import { useEffect } from "react";

// Warn before the browser unloads (reload / close / navigation) while the editor holds changes the
// server has not confirmed, so a pending or failed autosave is never discarded silently (#576). When
// `active` is false the guard is removed, so a fully-saved document leaves without a prompt.
export function useUnsavedChangesWarning(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
      // Some browsers still require assigning returnValue to trigger the native confirmation prompt.
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", warn);

    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [active]);
}
