import { describe, expect, it } from "vitest";

import { pdfStep, probePdfLane } from "./pdf.mjs";
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
  ocrmypdf = false,
  tesseract = false,
  brew = false,
  pipFails = false
} = {}) {
  const state = { python, docling, ocrmypdf, tesseract };
  const pipCalls = [];
  const execHandler = (command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "python --version") return state.python ? OK : FAIL;
    if (key === "python3 --version") return FAIL;
    if (key === "python -c import docling") return state.docling ? OK : FAIL;
    if (key === "python -m pip install docling") {
      pipCalls.push(key);
      if (pipFails) return { code: 1, stdout: "", stderr: "pip: could not resolve docling" };
      state.docling = true;
      return OK;
    }
    if (key === "ocrmypdf --version") return state.ocrmypdf ? OK : FAIL;
    if (key === "tesseract --version") return state.tesseract ? OK : FAIL;
    if (key === "brew --version") return brew ? OK : FAIL;
    if (key === "brew install ocrmypdf") {
      state.ocrmypdf = true;
      state.tesseract = true; // brew's ocrmypdf pulls Tesseract with it.
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

  it("reports OCRmyPDF missing distinctly when Python + Docling are present", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: false });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("OCRmyPDF");
  });

  it("reports Tesseract missing distinctly when OCRmyPDF is present without it", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: false });
    const result = probePdfLane(ctx);
    expect(result?.status).toBe("missing");
    expect(result?.what).toContain("Tesseract");
  });

  it("returns null when the whole lane is ready", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(probePdfLane(ctx)).toBeNull();
  });
});

describe("pdf step check", () => {
  it("is ok when Python, Docling, OCRmyPDF, and Tesseract are all present", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(pdfStep.check(ctx)).toEqual({ status: "ok" });
  });

  it("surfaces the first gap when the lane is incomplete", () => {
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

  it("installs Docling then reports ok when the rest of the lane is present", () => {
    const { ctx, pipCalls } = pdfContext({
      python: true,
      docling: false,
      ocrmypdf: true,
      tesseract: true
    });
    expect(pdfStep.provision(ctx)).toEqual({ status: "ok" });
    expect(pipCalls).toEqual(["python -m pip install docling"]);
  });

  it("maps a failing `pip install docling` to an actionable error with the output tail", () => {
    const { ctx } = pdfContext({ python: true, docling: false, pipFails: true });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("error");
    expect(result.what).toContain("docling");
    expect(result.remedy).toContain("could not resolve docling");
  });

  it("skips the Docling install when it is already present and surfaces the OCRmyPDF gap", () => {
    // Docling present (no pip), but OCRmyPDF absent with no consent → installSystemTool returns the
    // instruct-only OCRmyPDF remedy, which provision returns unchanged.
    const { ctx, pipCalls } = pdfContext({
      platform: "darwin",
      confirm: false,
      docling: true,
      ocrmypdf: false,
      brew: true
    });
    const result = pdfStep.provision(ctx);
    expect(result.status).toBe("missing");
    expect(result.what).toContain("OCRmyPDF");
    expect(pipCalls).toEqual([]);
  });

  it("consent-installs OCRmyPDF (bundling Tesseract) and reports the lane ready", () => {
    const { ctx } = pdfContext({
      platform: "darwin",
      confirm: true,
      python: true,
      docling: true,
      ocrmypdf: false,
      tesseract: false,
      brew: true
    });
    expect(pdfStep.provision(ctx)).toEqual({ status: "ok" });
  });
});

describe("pdf step verify", () => {
  it("is ok when the lane is fully provisioned", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: true, tesseract: true });
    expect(pdfStep.verify(ctx)).toEqual({ status: "ok" });
  });

  it("surfaces the remaining gap after a partial provision", () => {
    const { ctx } = pdfContext({ docling: true, ocrmypdf: false });
    expect(pdfStep.verify(ctx).status).toBe("missing");
  });
});
