// Optional setup step (#510): make the PDF ingestion lane work end to end with one command —
// `pnpm setup:pdf`. PDF upload converts the file to Markdown through the Docling worker
// (src/apps/server/src/files/pdf_to_markdown.py) behind an OCRmyPDF/Tesseract pre-pass for scanned
// pages (src/apps/server/src/files/pdfOcr.ts). Unlike the coach/speech lanes there is no runtime fake
// fallback in production wiring (index.ts always composes the real workers), so a fresh clone with no
// doc-AI toolchain reports a valid PDF as unreadable. This step closes that setup-coverage gap: it
// checks Python + Docling + OCRmyPDF + Tesseract, reporting each missing piece distinctly, installs
// what it safely can after explicit consent (Python + the Docling pip package), and leaves the heavy
// system tools (OCRmyPDF/Tesseract) instruct-only where no clean native install exists. Excluded from
// the base `pnpm setup` (heavy/network); every failure mode returns an actionable { what, remedy },
// never a raw crash.

import { installSystemTool } from "../installSystemTool.mjs";
import { error, isOk, missing, ok, withOutputTail } from "../step.mjs";

const PYTHON_DOCS = "https://www.python.org/downloads";
const PYTHON_REMEDY =
  "Install Python 3 (https://www.python.org/downloads, or `winget install Python.Python.3` / " +
  "`brew install python`), then re-run `pnpm setup:pdf`.";

const DOCLING_DOCS = "https://github.com/docling-project/docling";
const OCRMYPDF_DOCS = "https://ocrmypdf.readthedocs.io/en/latest/installation.html";
const OCRMYPDF_REMEDY =
  "Install OCRmyPDF (`brew install ocrmypdf` / `sudo apt install ocrmypdf`, or on Windows see " +
  "https://ocrmypdf.readthedocs.io/en/latest/installation.html), then re-run `pnpm setup:pdf`. " +
  "It provides the scanned-PDF OCR pre-pass and bundles Tesseract.";
const TESSERACT_DOCS = "https://tesseract-ocr.github.io/tessdoc/Installation.html";
const TESSERACT_REMEDY =
  "Install Tesseract OCR (`brew install tesseract` / `sudo apt install tesseract-ocr`, or on " +
  "Windows https://github.com/UB-Mannheim/tesseract/wiki), then re-run `pnpm setup:pdf`.";

/**
 * Resolve an available Python interpreter command, or null when none is on PATH.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string | null}
 */
function resolvePython(ctx) {
  for (const command of ["python", "python3"]) {
    if (ctx.exec(command, ["--version"]).code === 0) {
      return command;
    }
  }
  return null;
}

/**
 * Non-mutating readiness probe for the Python 3 system prerequisite.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {import("../step.mjs").StepResult}
 */
function pythonCheck(ctx) {
  return resolvePython(ctx) === null
    ? missing("Python 3 was not found (required to run the Docling PDF converter).", PYTHON_REMEDY)
    : ok();
}

/** @type {import("../installSystemTool.mjs").InstallSpec} */
const PYTHON_SPEC = {
  name: "Python 3",
  check: pythonCheck,
  remedy: PYTHON_REMEDY,
  docs: PYTHON_DOCS,
  question: "Install Python 3 now? [Y/n]",
  plans: {
    win32: { manager: "winget", args: ["install", "Python.Python.3"] },
    darwin: { manager: "brew", args: ["install", "python"] }
  }
};

/**
 * Is `ocrmypdf` on PATH? (its `--version` exits 0 when present).
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {boolean}
 */
function ocrmypdfPresent(ctx) {
  return ctx.exec("ocrmypdf", ["--version"]).code === 0;
}

/** @type {import("../installSystemTool.mjs").InstallSpec} */
const OCRMYPDF_SPEC = {
  name: "OCRmyPDF",
  check: (ctx) =>
    ocrmypdfPresent(ctx)
      ? ok()
      : missing(
          "OCRmyPDF was not found (required for the scanned-PDF OCR pre-pass).",
          OCRMYPDF_REMEDY,
          OCRMYPDF_DOCS
        ),
  remedy: OCRMYPDF_REMEDY,
  docs: OCRMYPDF_DOCS,
  question: "Install OCRmyPDF now? [Y/n]",
  // Native one-liners only where they cleanly pull OCRmyPDF (and Tesseract with it). Windows has no
  // clean single-command install, so it falls through to the instruct-only remedy above.
  plans: {
    darwin: { manager: "brew", args: ["install", "ocrmypdf"] }
  }
};

/**
 * Probe the PDF lane's four prerequisites in order, returning the FIRST gap distinctly (so the
 * report names exactly what is missing — Python, Docling, OCRmyPDF, or Tesseract), or null when the
 * whole lane is ready. Shared by `check` and `verify` so a post-provision probe uses the same logic.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {import("../step.mjs").StepResult | null}
 */
export function probePdfLane(ctx) {
  const python = resolvePython(ctx);
  if (python === null) {
    return missing(
      "Python 3 was not found (required to run the Docling PDF converter).",
      PYTHON_REMEDY,
      PYTHON_DOCS
    );
  }
  if (ctx.exec(python, ["-c", "import docling"]).code !== 0) {
    return missing(
      "The Docling Python package is not installed (required to convert PDFs to Markdown).",
      "Run `pnpm setup:pdf` to install it.",
      DOCLING_DOCS
    );
  }
  if (!ocrmypdfPresent(ctx)) {
    return missing(
      "OCRmyPDF was not found (required for the scanned-PDF OCR pre-pass).",
      OCRMYPDF_REMEDY,
      OCRMYPDF_DOCS
    );
  }
  if (ctx.exec("tesseract", ["--version"]).code !== 0) {
    return missing(
      "Tesseract OCR was not found (OCRmyPDF needs it to read scanned pages).",
      TESSERACT_REMEDY,
      TESSERACT_DOCS
    );
  }
  return null;
}

/** @type {import("../step.mjs").Step} */
export const pdfStep = {
  id: "pdf",
  title: "PDF ingestion (Docling + OCRmyPDF/Tesseract)",
  optional: true,
  capability: "pdf",
  check(ctx) {
    return probePdfLane(ctx) ?? ok();
  },
  provision(ctx) {
    // Consent-gated: offer to install Python 3 after an explicit Y (or `--yes`); on decline, no
    // package manager, or a non-interactive run, fall back to the instruct-only remedy unchanged.
    const pythonReady = installSystemTool(ctx, PYTHON_SPEC);
    if (!isOk(pythonReady)) {
      return pythonReady;
    }
    // pythonCheck (installSystemTool's source of truth) just passed, so an interpreter resolves here.
    const python = resolvePython(ctx);
    if (ctx.exec(python, ["-c", "import docling"]).code !== 0) {
      const pip = ctx.exec(python, ["-m", "pip", "install", "docling"]);
      if (pip.code !== 0) {
        return error(
          "`pip install docling` failed.",
          withOutputTail(
            "Ensure pip is available (`python -m ensurepip --upgrade`) and check your network/proxy, then re-run `pnpm setup:pdf`.",
            pip
          ),
          DOCLING_DOCS
        );
      }
    }
    // OCRmyPDF (and the Tesseract it bundles) is a heavy system install: consent-gated where a clean
    // native one-liner exists, instruct-only elsewhere. A not-ready result here is returned as-is so
    // the summary shows the exact remedy — never force-installed, never a crash.
    const ocrReady = installSystemTool(ctx, OCRMYPDF_SPEC);
    if (!isOk(ocrReady)) {
      return ocrReady;
    }
    return probePdfLane(ctx) ?? ok();
  },
  verify(ctx) {
    return probePdfLane(ctx) ?? ok();
  }
};
