import type { CaseLightLevel } from "@whetstone/contracts";

// Pure presentational token maps for the fog-of-war map: a case's light level -> its tile classes and
// its human label. Static enum -> string maps with no logic (theme-aware via the shared colour
// tokens), kept out of coverage like the other `*.tokens` modules.

// lit = owned (success-tinted), dim = in progress (accent edge), dark = unknown (faint).
const tileClassByLight: Readonly<Record<CaseLightLevel, string>> = {
  dark: "border-border bg-bg text-text-muted opacity-80",
  dim: "border-accent bg-surface text-text",
  lit: "border-success bg-surface text-text"
};

export function lightTileClass(light: CaseLightLevel): string {
  return tileClassByLight[light];
}

const labelByLight: Readonly<Record<CaseLightLevel, string>> = {
  dark: "Unknown",
  dim: "In progress",
  lit: "Owned"
};

export function lightLabel(light: CaseLightLevel): string {
  return labelByLight[light];
}
