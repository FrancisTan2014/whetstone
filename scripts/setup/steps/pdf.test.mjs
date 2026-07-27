import { describe, expect, it } from "vitest";

import {
  pdfReadiness,
  pdfStep,
  probeOcrReadiness,
  probePdfLane,
  probeWindowsMemoryBoundary,
  provisionWindowsMemoryBoundary
} from "./pdf.mjs";
import { createFakeContext } from "../testSupport.mjs";

const OK = { code: 0, stdout: "", stderr: "" };
const FAIL = { code: 1, stdout: "", stderr: "" };

// A stateful fake context for the PDF step: exec results are computed from mutable capability flags
// so an install (pip docling / brew ocrmypdf) can flip the corresponding probe from missing to found,
// exactly as `installSystemTool` re-probes after installing. `python --version` resolves the
// interpreter; the rest mirror the real probe commands.
function pdfContext({
  platform = "linux",
  confirm = false,
  python = true,
  docling = false,
  doclingPinned,
  models,
  pywin32 = true,
  ceilingEnforced = true,
  pywin32PipFails = false,
  ocrmypdf = false,
  tesseract = false,
  eng,
  chiSim,
  chiTra,
  brew = false,
  pipFails = false,
  modelDownloadFails = false,
  listLangsFails = false,
  listLangsBlankOutput = false
} = {}) {
  const state = {
    python,
    docling,
    // When a test does not say otherwise, an installed Docling is assumed to be the pinned version
    // with its models cached — so existing "lane ready" cases stay ready.
    doclingPinned: doclingPinned === undefined ? docling : doclingPinned,
    models: models === undefined ? docling : models,
    // Windows structured-worker memory boundary (#782); only consulted on win32. Ready by default so a
    // fully-provisioned win32 context is ready; a test flips these to exercise the boundary gaps.
    pywin32,
    ceilingEnforced,
    ocrmypdf,
    tesseract,
    // A present Tesseract ships with every required pack by default, so existing "both tools present"
    // cases stay ready; a test overrides an individual pack to exercise the missing-pack path.
    eng: eng === undefined ? tesseract : eng,
    chiSim: chiSim === undefined ? tesseract : chiSim,
    chiTra: chiTra === undefined ? tesseract : chiTra
  };
  const pipCalls = [];
  const execHandler = (command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "python --version") return state.python ? OK : FAIL;
    if (key === "python3 --version") return FAIL;
    if (key === "python -c import docling") return state.docling ? OK : FAIL;
    // The pywin32 pin probe also uses importlib.metadata, so it must be matched BEFORE the Docling one.
    if (command === "python" && args[0] === "-c" && args[1].includes("pywin32")) {
      return state.pywin32 ? OK : FAIL;
    }
    if (command === "python" && args[0] === "-c" && args[1].includes("importlib.metadata")) {
      return state.doclingPinned ? OK : FAIL;
    }
    if (command === "python" && args[args.length - 1] === "--check-memory-ceiling") {
      return state.ceilingEnforced
        ? { code: 0, stdout: '{"ceilingEnforced":true,"memoryMib":2048}', stderr: "" }
        : { code: 8, stdout: "", stderr: "a per-child memory ceiling could not be enforced" };
    }
    if (
      command === "python" &&
      args[0] === "-m" &&
      args[1] === "pip" &&
      args[2] === "install" &&
      String(args[3]).startsWith("pywin32==")
    ) {
      pipCalls.push(key);
      if (pywin32PipFails) return { code: 1, stdout: "", stderr: "pip: could not resolve pywin32" };
      state.pywin32 = true;
      return OK;
    }
    if (command === "python" && args[0] === "-c" && args[1].includes("local_files_only")) {
      return state.models ? OK : FAIL;
    }
    if (command === "python" && args[0] === "-c" && args[1].includes("snapshot_download")) {
      if (modelDownloadFails) return { code: 1, stdout: "", stderr: "hf: could not fetch models" };
      state.models = true;
      return OK;
    }
    if (
      command === "python" &&
      args[0] === "-m" &&
      args[1] === "pip" &&
      args[2] === "install" &&
      String(args[3]).startsWith("docling==")
    ) {
      pipCalls.push(key);
      if (pipFails) return { code: 1, stdout: "", stderr: "pip: could not resolve docling" };
      state.docling = true;
      state.doclingPinned = true;
      return OK;
    }
    if (key === "ocrmypdf --version") return state.ocrmypdf ? OK : FAIL;
    if (key === "tesseract --version") return state.tesseract ? OK : FAIL;
    if (key === "tesseract --list-langs") {
      if (!state.tesseract) return FAIL;
      // A present Tesseract whose `--list-langs` still exits non-zero (a broken tessdata prefix, a
      // corrupt install) can enumerate no packs, so the required packs are reported missing distinctly.
      if (listLangsFails) return { code: 1, stdout: "", stderr: "read_params_file: cannot open" };
      // A zero-exit `--list-langs` that emits no stream at all (no stdout, no stderr): the language
      // scan falls back to an empty list, so no pack can be confirmed present.
      if (listLangsBlankOutput) return { code: 0 };
      const langs = ["osd"];
      if (state.eng) langs.push("eng");
      if (state.chiSim) langs.push("chi_sim");
      if (state.chiTra) langs.push("chi_tra");
      return { code: 0, stdout: `List of available languages:\n${langs.join("\n")}\n`, stderr: "" };
    }
    if (key === "brew --version") return brew ? OK : FAIL;
    if (key === "brew install ocrmypdf") {
      state.ocrmypdf = true;
      state.tesseract = true; // brew's ocrmypdf pulls Tesseract with it.
      state.eng = true; // and the bundled Tesseract carries every required pack.
      state.chiSim = true;
      state.chiTra = true;
      return OK;
    }
    return OK;
  };
  const fake = createFakeContext({ platform, confirm, execHandler });
  return { ...fake, pipCalls };
}

describe("probePdfLane", () => {
  it("reports Python missing first, with a setup:pdf remedy", () => {
    const { ctx } = pdfContext({ python: false });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("Python 3 was not found");
  });

  it("reports Docling missing distinctly when Python is present", () => {
    const { ctx } = pdfContext({ python: true, docling: false });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("Docling");
    expect(result?.remedy).toContain("pnpm setup:pdf");
  });

  it("reports a version-pin mismatch distinctly when Docling is present but unpinned", () => {
    const { ctx } = pdfContext({ docling: true, doclingPinned: false });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("pinned versions");
    expect(result?.what).toContain("2.114.0");
  });

  it("reports the pinned models missing distinctly when the runtime is pinned but uncached", () => {
    const { ctx } = pdfContext({ docling: true, doclingPinned: true, models: false });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("model artifacts");
    // The message must surface the IMMUTABLE commit fingerprint, not just the mutable tag.
    expect(result?.what).toContain("fc0f2d45e2218ea24bce5045f58a389aed16dc23");
  });

  it("is ready (null) on the born-digital prerequisites alone — OCR tooling never gates it", () => {
    // Python + pinned Docling + cached models present, but OCRmyPDF/Tesseract absent: the born-digital
    // lane is ready because #702 ships with OCR disabled.
    const { ctx } = pdfContext({ docling: true, ocrmypdf: false, tesseract: false });
    expect(probePdfLane(ctx)).toBeNull();
  });

  it("returns null when the whole lane is ready", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(probePdfLane(ctx)).toBeNull();
  });

  it("blocks on Windows when the pinned pywin32 Job Object boundary is absent (#782)", () => {
    // The born-digital prerequisites are all present, but Windows enforces the per-child memory ceiling
    // through a Job Object via pywin32; without it the worker would refuse fail-closed.
    const { ctx } = pdfContext({ platform: "win32", docling: true, pywin32: false });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("pywin32==312");
    expect(result?.remedy).toContain("pywin32==312");
  });

  it("blocks on Windows when the Job Object ceiling cannot be enforced even with pywin32 present (#782)", () => {
    // pywin32 is the pinned build, but the capability probe (the real controller) fails — importing the
    // package is not readiness; the ceiling must actually apply.
    const { ctx } = pdfContext({
      platform: "win32",
      docling: true,
      pywin32: true,
      ceilingEnforced: false
    });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("could not be enforced");
  });

  it("is ready on Windows when pywin32 is pinned and the ceiling is enforceable (#782)", () => {
    const { ctx } = pdfContext({
      platform: "win32",
      docling: true,
      ocrmypdf: true,
      tesseract: true,
      pywin32: true,
      ceilingEnforced: true
    });
    expect(probePdfLane(ctx)).toBeNull();
  });
});

describe("probeOcrReadiness", () => {
  it("reports OCRmyPDF missing distinctly as the English OCR lane (#745)", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: false });
    const result = probeOcrReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("OCRmyPDF");
    expect(result?.what).toContain("#745");
  });

  it("reports Tesseract missing distinctly when OCRmyPDF is present without it", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: false });
    const result = probeOcrReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("Tesseract");
  });

  it("reports the English trained-data pack missing distinctly when Tesseract lacks it", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true, eng: false });
    const result = probeOcrReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("English");
    expect(result?.what).toContain("eng");
  });

  it("reports the Simplified Chinese trained-data pack missing distinctly when Tesseract lacks it (#746)", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true, chiSim: false });
    const result = probeOcrReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("Simplified Chinese");
    expect(result?.what).toContain("chi_sim");
    expect(result?.remedy).toContain("tesseract-ocr-chi-sim");
  });

  it("reports the Traditional Chinese trained-data pack missing distinctly when Tesseract lacks it (#746)", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true, chiTra: false });
    const result = probeOcrReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("Traditional Chinese");
    expect(result?.what).toContain("chi_tra");
    expect(result?.remedy).toContain("tesseract-ocr-chi-tra");
  });

  it("reports the English pack missing when `tesseract --list-langs` exits non-zero", () => {
    // Tesseract is present (its `--version` succeeds) but `--list-langs` fails, so no pack — including
    // `eng` — can be confirmed. The English trained-data gap is surfaced rather than assumed present.
    const { ctx } = pdfContext({
      docling: true,
      ocrmypdf: true,
      tesseract: true,
      listLangsFails: true
    });
    const result = probeOcrReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("English");
    expect(result?.what).toContain("eng");
  });

  it("reports the English pack missing when `tesseract --list-langs` emits no output", () => {
    // A zero-exit `--list-langs` with neither stdout nor stderr yields an empty language list, so `eng`
    // is reported missing rather than crashing on the absent streams.
    const { ctx } = pdfContext({
      docling: true,
      ocrmypdf: true,
      tesseract: true,
      listLangsBlankOutput: true
    });
    const result = probeOcrReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("eng");
  });

  it("returns null when both OCR tools and the English pack are present", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(probeOcrReadiness(ctx)).toBeNull();
  });
});

describe("pdfReadiness", () => {
  it("returns null only when both the born-digital and OCR lanes are ready", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(pdfReadiness(ctx)).toBeNull();
  });

  it("surfaces a born-digital gap before an OCR gap (born-digital is the base every PDF needs)", () => {
    // Neither lane ready: the born-digital gap (Docling) must win so the report names the base first.
    const { ctx } = pdfContext({ docling: false, ocrmypdf: false });
    const result = pdfReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("Docling");
  });

  it("surfaces the OCR gap once the born-digital lane is ready", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: false });
    const result = pdfReadiness(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("OCRmyPDF");
    expect(result?.what).toContain("#745");
  });
});

describe("pdf step check", () => {
  it("is ok when both the born-digital and OCR prerequisites are present", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(pdfStep.check(ctx)).toEqual({ status: "ok" });
  });

  it("blocks with an actionable OCR remedy when OCR tooling is missing (#745)", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: false, tesseract: false });
    const result = pdfStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("OCRmyPDF");
    expect(result.what).toContain("#745");
    expect(result.remedy).toContain("OCRmyPDF");
  });

  it("blocks when Tesseract lacks the English `eng` pack", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true, eng: false });
    const result = pdfStep.check(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("eng");
  });

  it("surfaces the first born-digital gap when the lane is incomplete", () => {
    const { ctx } = pdfContext({ docling: false });
    expect(pdfStep.check(ctx).status).toBe("missing");
  });
});

describe("pdf step provision", () => {
  it("stops at Python (instruct-only) when it is absent and no install is possible/consented", () => {
    // linux has no PYTHON_SPEC plan, so installSystemTool returns instruct-only missing; docling pip
    // must not run.
    const { ctx, pipCalls } = pdfContext({ platform: "linux", python: false });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("Python");
    expect(pipCalls).toEqual([]);
  });

  it("installs the pinned Docling then reports ok when the models are present", () => {
    const { ctx, pipCalls } = pdfContext({
      python: true,
      docling: false,
      ocrmypdf: true,
      tesseract: true
    });
    expect(pdfStep.provision(ctx)).toEqual({ status: "ok" });
    expect(pipCalls).toHaveLength(1);
    expect(pipCalls[0]).toContain("pip install docling==");
    expect(pipCalls[0]).toContain("docling-core==");
  });

  it("maps a failing pinned `pip install` to an actionable error with the output tail", () => {
    const { ctx } = pdfContext({ python: true, docling: false, pipFails: true });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("docling");
    expect(result.remedy).toContain("could not resolve docling");
  });

  it("maps a failing model download to an actionable error with the output tail", () => {
    const { ctx, pipCalls } = pdfContext({
      python: true,
      docling: true,
      doclingPinned: true,
      models: false,
      ocrmypdf: true,
      tesseract: true,
      modelDownloadFails: true
    });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("models");
    expect(result.remedy).toContain("Hugging Face");
    // The runtime was already pinned, so no pip install ran — only the model download was attempted.
    expect(pipCalls).toEqual([]);
  });

  it("blocks with the OCR remedy after provisioning the born-digital lane when OCR tooling is absent", () => {
    // Docling + models present but OCRmyPDF/Tesseract absent: provision installs no OCR tooling and now
    // surfaces the OCR gap as a blocking, actionable remedy (#745) rather than reporting ready.
    const { ctx, pipCalls } = pdfContext({
      platform: "darwin",
      confirm: false,
      python: true,
      docling: true,
      ocrmypdf: false,
      tesseract: false,
      brew: true
    });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("OCRmyPDF");
    expect(result.remedy).toContain("OCRmyPDF");
    expect(pipCalls).toEqual([]);
  });

  it("installs the pinned pywin32 Job Object boundary on Windows then reports ready (#782)", () => {
    // Born-digital runtime + models present, pywin32 absent: provision pip-installs the pinned pywin32,
    // the capability probe then confirms the ceiling is enforceable, and the lane is ready.
    const { ctx, pipCalls } = pdfContext({
      platform: "win32",
      python: true,
      docling: true,
      doclingPinned: true,
      models: true,
      pywin32: false,
      ceilingEnforced: true,
      ocrmypdf: true,
      tesseract: true
    });
    expect(pdfStep.provision(ctx)).toEqual({ status: "ok" });
    expect(pipCalls).toHaveLength(1);
    expect(pipCalls[0]).toContain("pip install pywin32==312");
  });

  it("maps a failing pinned pywin32 install to an actionable error with the output tail (#782)", () => {
    const { ctx } = pdfContext({
      platform: "win32",
      python: true,
      docling: true,
      doclingPinned: true,
      models: true,
      pywin32: false,
      pywin32PipFails: true
    });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("pywin32==312");
    expect(result.remedy).toContain("could not resolve pywin32");
  });

  it("blocks after installing pywin32 when the Job Object ceiling still cannot be enforced (#782)", () => {
    // pywin32 installs, but the capability probe fails (e.g. an outer job forbids assignment): provision
    // surfaces the boundary gap rather than reporting ready.
    const { ctx } = pdfContext({
      platform: "win32",
      python: true,
      docling: true,
      doclingPinned: true,
      models: true,
      pywin32: false,
      ceilingEnforced: false
    });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("could not be enforced");
  });
});

describe("probeWindowsMemoryBoundary", () => {
  it("is a no-op (null) on POSIX, whose RLIMIT_AS boundary needs no package", () => {
    const { ctx } = pdfContext({ platform: "linux", pywin32: false, ceilingEnforced: false });
    expect(probeWindowsMemoryBoundary(ctx, "python")).toBeNull();
  });

  it("returns null on Windows when pywin32 is pinned and the ceiling is enforceable", () => {
    const { ctx } = pdfContext({ platform: "win32", pywin32: true, ceilingEnforced: true });
    expect(probeWindowsMemoryBoundary(ctx, "python")).toBeNull();
  });
});

describe("provisionWindowsMemoryBoundary", () => {
  it("is ok and installs nothing on POSIX", () => {
    const { ctx, pipCalls } = pdfContext({ platform: "linux" });
    expect(provisionWindowsMemoryBoundary(ctx, "python")).toEqual({ status: "ok" });
    expect(pipCalls).toEqual([]);
  });

  it("skips the install when the pinned pywin32 is already present and enforceable", () => {
    const { ctx, pipCalls } = pdfContext({
      platform: "win32",
      pywin32: true,
      ceilingEnforced: true
    });
    expect(provisionWindowsMemoryBoundary(ctx, "python")).toEqual({ status: "ok" });
    expect(pipCalls).toEqual([]);
  });
});

describe("pdf step verify", () => {
  it("is ok when the born-digital lane is fully provisioned", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(pdfStep.verify(ctx)).toEqual({ status: "ok" });
  });

  it("blocks with the OCR remedy when the born-digital lane is ready but OCR tooling is absent", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: false });
    const result = pdfStep.verify(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("OCRmyPDF");
  });

  it("surfaces the remaining born-digital gap after a partial provision", () => {
    const { ctx } = pdfContext({ docling: false });
    expect(pdfStep.verify(ctx).status).toBe("missing");
  });
});
