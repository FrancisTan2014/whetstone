import { createContext, useContext, useMemo } from "react";

// The one shared boundary that decides where the rich editor's floating surfaces (formatting toolbar,
// link form, slash menu, block-actions menu) portal to. Every surface reads this getter and appends
// into the node it returns, so a single provider re-homes all of them at once. Outside a provider the
// getter resolves to `document.body` — the ecosystem default — so standalone editors behave exactly as
// before. Inside a modal `Sheet` the provider hands down a host that lives INSIDE the Radix Dialog's
// stacking + focus scope, so the surfaces stay visible, interactive, and above the overlay (#645).
export type FloatingLayerContainer = () => HTMLElement;

// A module-level constant so the default value keeps a stable identity across renders — the BubbleMenu
// re-dispatches an `updateOptions` transaction whenever its `appendTo` changes identity, and a fresh
// getter each render would loop it.
const bodyContainer: FloatingLayerContainer = () => window.document.body;

const FloatingLayerContext = createContext<FloatingLayerContainer>(bodyContainer);

export interface FloatingLayerProviderProps {
  /** The host node descendants portal into; `null` (e.g. before it mounts) falls back to the body. */
  readonly container: HTMLElement | null;
  readonly children: React.ReactNode;
}

// Supplies a specific node's getter to descendants. The getter is memoized on the node so its identity
// only changes when the host node does, keeping consumers (the memoized BubbleMenu options, the slash
// extension) stable.
export function FloatingLayerProvider({
  container,
  children
}: FloatingLayerProviderProps): React.JSX.Element {
  const value = useMemo<FloatingLayerContainer>(
    () => (container === null ? bodyContainer : () => container),
    [container]
  );

  return <FloatingLayerContext.Provider value={value}>{children}</FloatingLayerContext.Provider>;
}

// The getter for the current floating-layer container. Stable identity: the default constant outside a
// provider, or the provider's memoized getter inside one.
export function useFloatingLayerContainer(): FloatingLayerContainer {
  return useContext(FloatingLayerContext);
}
