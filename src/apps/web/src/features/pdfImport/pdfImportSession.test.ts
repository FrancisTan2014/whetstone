import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forgetActivePdfImport,
  readActivePdfImport,
  rememberActivePdfImport
} from "./pdfImportSession";

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    globalThis.localStorage?.clear();
  } catch {
    // No store to clear in this environment.
  }
});

// A minimal in-memory Storage stand-in whose methods can be overridden to simulate a throwing store.
function memoryStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();
  return {
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    removeItem: (key) => map.delete(key),
    setItem: (key, value) => {
      map.set(key, value);
    },
    ...overrides
  } as Storage;
}

describe("pdfImportSession", () => {
  it("round-trips the remembered attempt id", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    rememberActivePdfImport("attempt-42");

    expect(readActivePdfImport()).toBe("attempt-42");
  });

  it("reports no remembered import once forgotten", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    rememberActivePdfImport("attempt-42");

    forgetActivePdfImport();

    expect(readActivePdfImport()).toBeNull();
  });

  it("treats an empty stored value as no remembered import", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    rememberActivePdfImport("");

    expect(readActivePdfImport()).toBeNull();
  });

  it("returns null when there is nothing remembered", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    expect(readActivePdfImport()).toBeNull();
  });

  it("degrades to no remembered import when the store throws on read", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        getItem: () => {
          throw new Error("blocked");
        }
      })
    );

    expect(readActivePdfImport()).toBeNull();
  });

  it("swallows a throwing setItem so the upload flow never breaks", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        setItem: () => {
          throw new Error("full");
        }
      })
    );

    expect(() => rememberActivePdfImport("attempt-1")).not.toThrow();
  });

  it("swallows a throwing removeItem", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        removeItem: () => {
          throw new Error("blocked");
        }
      })
    );

    expect(() => forgetActivePdfImport()).not.toThrow();
  });

  it("reports no remembered import when the environment has no localStorage", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(readActivePdfImport()).toBeNull();
    expect(() => rememberActivePdfImport("attempt-1")).not.toThrow();
    expect(() => forgetActivePdfImport()).not.toThrow();
  });

  it("degrades when accessing the store itself throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      }
    });

    expect(readActivePdfImport()).toBeNull();
    expect(() => rememberActivePdfImport("attempt-1")).not.toThrow();
    expect(() => forgetActivePdfImport()).not.toThrow();
  });
});
