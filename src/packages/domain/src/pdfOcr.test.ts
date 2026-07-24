import { describe, expect, it } from "vitest";

import {
  classifyOcrRouting,
  OCR_GEOMETRY_TOLERANCE_PT,
  ocrPassRequired,
  ocrTesseractLanguage,
  requiredTesseractTraineddata,
  resolveOcrLanguage,
  validateNativeTextPreserved,
  validateOcrGeometry,
  type OcrPageGeometry
} from "./pdfOcr.js";
import { workLanguages, type WorkLanguage } from "./work.js";

describe("ocr pass gating", () => {
  it("runs the OCR pass only for a text-less document (language-independent now)", () => {
    // Chinese now ships an OCR pack (#746), so the pass is gated only by routing kind: a scanned or
    // mixed document OCRs in any language; a native (born-digital) document never does.
    expect(ocrPassRequired("scanned")).toBe(true);
    expect(ocrPassRequired("mixed")).toBe(true);
    expect(ocrPassRequired("native")).toBe(false);
  });
});

describe("ocr language selection", () => {
  it("maps each Work language to its exact Tesseract -l value", () => {
    expect(ocrTesseractLanguage("en")).toBe("eng");
    expect(ocrTesseractLanguage("zh-CN")).toBe("chi_sim+eng");
    expect(ocrTesseractLanguage("zh-TW")).toBe("chi_tra+eng");
  });

  it("reports the exact trained-data packs each language requires", () => {
    expect(requiredTesseractTraineddata("en")).toEqual(["eng"]);
    expect(requiredTesseractTraineddata("zh-CN")).toEqual(["chi_sim", "eng"]);
    expect(requiredTesseractTraineddata("zh-TW")).toEqual(["chi_tra", "eng"]);
  });

  it("keeps the -l value and the pack list consistent for every language", () => {
    for (const language of workLanguages) {
      expect(ocrTesseractLanguage(language).split("+")).toEqual([
        ...requiredTesseractTraineddata(language)
      ]);
    }
  });

  it("falls back to the Work language when no override is chosen", () => {
    expect(resolveOcrLanguage("en", null)).toBe("en");
    expect(resolveOcrLanguage("zh-CN", null)).toBe("zh-CN");
  });

  it("uses an explicit override chosen before starting", () => {
    expect(resolveOcrLanguage("en", "zh-TW")).toBe("zh-TW");
    expect(resolveOcrLanguage("zh-CN", "en")).toBe("en");
  });
});

describe("ocr page routing", () => {
  it("routes a fully native document as native with no pages needing OCR", () => {
    const decision = classifyOcrRouting([
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: true }
    ]);
    expect(decision.kind).toBe("native");
    expect(decision.pageNumbersNeedingOcr).toEqual([]);
    expect(decision.nativePageCount).toBe(2);
    expect(decision.ocrPageCount).toBe(0);
  });

  it("routes a fully text-less document as scanned with every page needing OCR", () => {
    const decision = classifyOcrRouting([
      { pageNumber: 1, hasNativeText: false },
      { pageNumber: 2, hasNativeText: false }
    ]);
    expect(decision.kind).toBe("scanned");
    expect(decision.pageNumbersNeedingOcr).toEqual([1, 2]);
    expect(decision.nativePageCount).toBe(0);
    expect(decision.ocrPageCount).toBe(2);
  });

  it("routes a mixed document as mixed and only lists text-less pages, ascending", () => {
    const decision = classifyOcrRouting([
      { pageNumber: 3, hasNativeText: false },
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false }
    ]);
    expect(decision.kind).toBe("mixed");
    expect(decision.pageNumbersNeedingOcr).toEqual([2, 3]);
    expect(decision.nativePageCount).toBe(1);
    expect(decision.ocrPageCount).toBe(2);
  });

  it("keeps a duplicated text-less page scanned with zero native pages", () => {
    const decision = classifyOcrRouting([
      { pageNumber: 1, hasNativeText: false },
      { pageNumber: 1, hasNativeText: false }
    ]);
    expect(decision.kind).toBe("scanned");
    expect(decision.pageNumbersNeedingOcr).toEqual([1]);
    expect(decision.ocrPageCount).toBe(1);
    expect(decision.nativePageCount).toBe(0);
  });

  it("counts each page once when native and text-less pages are duplicated", () => {
    const decision = classifyOcrRouting([
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false },
      { pageNumber: 2, hasNativeText: false }
    ]);
    expect(decision.kind).toBe("mixed");
    expect(decision.pageNumbersNeedingOcr).toEqual([2]);
    expect(decision.ocrPageCount).toBe(1);
    expect(decision.nativePageCount).toBe(1);
  });

  it("treats an empty document as native", () => {
    const decision = classifyOcrRouting([]);
    expect(decision.kind).toBe("native");
    expect(decision.nativePageCount).toBe(0);
    expect(decision.ocrPageCount).toBe(0);
  });
});

describe("ocr geometry validation", () => {
  const page = (pageNumber: number, overrides: Partial<OcrPageGeometry> = {}): OcrPageGeometry => ({
    pageNumber,
    width: 612,
    height: 792,
    rotation: 0,
    ...overrides
  });

  it("accepts output that preserves page count, boxes, and rotation", () => {
    const before = [page(1), page(2, { rotation: 90 })];
    const after = [page(2, { rotation: 90 }), page(1)];
    expect(validateOcrGeometry(before, after)).toEqual({ ok: true });
  });

  it("accepts a sub-point box nudge within the default tolerance", () => {
    const before = [page(1)];
    const after = [page(1, { width: 612 + OCR_GEOMETRY_TOLERANCE_PT })];
    expect(validateOcrGeometry(before, after)).toEqual({ ok: true });
  });

  it("rejects a changed page count", () => {
    const result = validateOcrGeometry([page(1)], [page(1), page(2)]);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "page_count_changed" });
  });

  it("rejects output missing a page even when the count matches", () => {
    const result = validateOcrGeometry([page(1), page(2)], [page(1), page(3)]);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "page_missing" });
  });

  it("rejects a width change beyond tolerance", () => {
    const result = validateOcrGeometry([page(1)], [page(1, { width: 700 })]);
    expect(result).toMatchObject({ ok: false, reason: "dimensions_changed" });
  });

  it("rejects a height change beyond tolerance", () => {
    const result = validateOcrGeometry([page(1)], [page(1, { height: 900 })]);
    expect(result).toMatchObject({ ok: false, reason: "dimensions_changed" });
  });

  it("rejects a rotation change", () => {
    const result = validateOcrGeometry([page(1)], [page(1, { rotation: 90 })]);
    expect(result).toMatchObject({ ok: false, reason: "rotation_changed" });
  });

  it("honors an explicit tolerance override", () => {
    const before = [page(1)];
    const after = [page(1, { width: 615 })];
    expect(validateOcrGeometry(before, after, { tolerancePt: 5 })).toEqual({ ok: true });
    expect(validateOcrGeometry(before, after, { tolerancePt: 1 })).toMatchObject({
      ok: false,
      reason: "dimensions_changed"
    });
  });
});

describe("native text preservation", () => {
  it("accepts output that keeps every native page's text", () => {
    const before = [
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false }
    ];
    const after = [
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: true }
    ];
    expect(validateNativeTextPreserved(before, after)).toEqual({ ok: true });
  });

  it("rejects output that dropped a native page's text", () => {
    const before = [{ pageNumber: 1, hasNativeText: true }];
    const after = [{ pageNumber: 1, hasNativeText: false }];
    expect(validateNativeTextPreserved(before, after)).toEqual({ ok: false, pageNumber: 1 });
  });

  it("rejects output where a native page vanished entirely", () => {
    const before = [{ pageNumber: 1, hasNativeText: true }];
    const after: { pageNumber: number; hasNativeText: boolean }[] = [];
    expect(validateNativeTextPreserved(before, after)).toEqual({ ok: false, pageNumber: 1 });
  });

  it("ignores pages that were already text-less before the pass", () => {
    const before = [{ pageNumber: 1, hasNativeText: false }];
    const after = [{ pageNumber: 1, hasNativeText: false }];
    expect(validateNativeTextPreserved(before, after)).toEqual({ ok: true });
  });
});

describe("immutability of public results", () => {
  it("returns a frozen routing decision whose page list cannot be mutated", () => {
    const decision = classifyOcrRouting([
      { pageNumber: 2, hasNativeText: false },
      { pageNumber: 1, hasNativeText: true }
    ]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.pageNumbersNeedingOcr)).toBe(true);
    expect(() => {
      (decision.pageNumbersNeedingOcr as number[]).push(99);
    }).toThrow(TypeError);
    expect(() => {
      (decision as { nativePageCount: number }).nativePageCount = 99;
    }).toThrow(TypeError);
    expect(decision.pageNumbersNeedingOcr).toEqual([2]);
    expect(decision.nativePageCount).toBe(1);
  });

  it("returns a frozen geometry validation for both the ok and failure results", () => {
    const ok = validateOcrGeometry(
      [{ pageNumber: 1, width: 612, height: 792, rotation: 0 }],
      [{ pageNumber: 1, width: 612, height: 792, rotation: 0 }]
    );
    expect(Object.isFrozen(ok)).toBe(true);
    expect(() => {
      (ok as { ok: boolean }).ok = false;
    }).toThrow(TypeError);
    expect(ok).toEqual({ ok: true });

    const failure = validateOcrGeometry(
      [{ pageNumber: 1, width: 612, height: 792, rotation: 0 }],
      [{ pageNumber: 1, width: 900, height: 792, rotation: 0 }]
    );
    expect(Object.isFrozen(failure)).toBe(true);
    expect(() => {
      (failure as { reason: string }).reason = "rotation_changed";
    }).toThrow(TypeError);
    expect(failure).toMatchObject({ ok: false, reason: "dimensions_changed" });
  });

  it("returns a frozen native-text validation for both the ok and failure results", () => {
    const ok = validateNativeTextPreserved(
      [{ pageNumber: 1, hasNativeText: false }],
      [{ pageNumber: 1, hasNativeText: false }]
    );
    expect(Object.isFrozen(ok)).toBe(true);
    expect(() => {
      (ok as { ok: boolean }).ok = false;
    }).toThrow(TypeError);
    expect(ok).toEqual({ ok: true });

    const failure = validateNativeTextPreserved(
      [{ pageNumber: 1, hasNativeText: true }],
      [{ pageNumber: 1, hasNativeText: false }]
    );
    expect(Object.isFrozen(failure)).toBe(true);
    expect(() => {
      (failure as { pageNumber: number }).pageNumber = 99;
    }).toThrow(TypeError);
    expect(failure).toEqual({ ok: false, pageNumber: 1 });
  });
});

describe("work language coverage", () => {
  it("has a language and pack mapping for every supported Work language", () => {
    const languages: readonly WorkLanguage[] = workLanguages;
    for (const language of languages) {
      expect(ocrTesseractLanguage(language)).toMatch(/^[a-z_+]+$/);
      expect(requiredTesseractTraineddata(language).length).toBeGreaterThan(0);
    }
  });
});
