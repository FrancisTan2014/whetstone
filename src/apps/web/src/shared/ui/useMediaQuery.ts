import { useEffect, useState } from "react";

// Subscribe to a CSS media query, re-rendering when it changes. Used by responsive
// primitives (e.g. the Sheet) to pick a layout in JS where CSS alone cannot — such as
// choosing a Framer Motion enter direction. Reads the live value on mount and on change.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handleChange = (): void => {
      setMatches(mediaQuery.matches);
    };

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [query]);

  return matches;
}
