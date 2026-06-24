// Minimal, dependency-free narrowing for untrusted JSON read at the provider boundary.
// Each external response is shaped however the source likes; these guards let the pure
// adapters read only the fields they understand and ignore everything else.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
