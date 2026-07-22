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

// Pinned Docling runtime + model artifacts for the structured adapter (#701). In LOCKSTEP with the
// PINNED_* constants in src/packages/contracts/src/pdfStructuredContracts.ts — this .mjs cannot import
// the .ts, so update both together. Setup reports the PDF lane ready only when these EXACT versions
// and the pinned model snapshot are present locally, so a drifting Docling can never silently change
// structured output or leave a first conversion to a surprise network download.
const PINNED_DOCLING_VERSION = "2.114.0";
const PINNED_DOCLING_CORE_VERSION = "2.87.1";
const PINNED_MODEL_REPO = "docling-project/docling-models";
// Pin the IMMUTABLE commit SHA, not the mutable `v2.3.0` tag: a moved tag can otherwise resolve to
// different artifacts and still pass readiness. `PINNED_MODEL_TAG` is a human-readable label only —
// setup downloads and verifies the exact commit below. Keep both in lockstep with the contract.
const PINNED_MODEL_TAG = "v2.3.0";
const PINNED_MODEL_COMMIT = "fc0f2d45e2218ea24bce5045f58a389aed16dc23";

// One-line Python probes (stable so the setup tests can match them). The version probe exits non-zero
// unless BOTH pinned versions are installed; the model probe loads the pinned snapshot from cache only
// (`local_files_only=True`) at the exact pinned commit, exiting non-zero when it is not already
// downloaded at that fingerprint.
const VERSION_PROBE =
  `import importlib.metadata as m,sys;` +
  `sys.exit(0 if m.version('docling')=='${PINNED_DOCLING_VERSION}' ` +
  `and m.version('docling-core')=='${PINNED_DOCLING_CORE_VERSION}' else 1)`;
const MODEL_PROBE =
  `from huggingface_hub import snapshot_download;` +
  `snapshot_download('${PINNED_MODEL_REPO}',revision='${PINNED_MODEL_COMMIT}',local_files_only=True)`;
const MODEL_DOWNLOAD =
  `from huggingface_hub import snapshot_download;` +
  `snapshot_download('${PINNED_MODEL_REPO}',revision='${PINNED_MODEL_COMMIT}')`;

const DOCLING_PIN_REMEDY = "Run `pnpm setup:pdf` to install the exact pinned versions.";
const MODEL_REMEDY = "Run `pnpm setup:pdf` to download the exact pinned model snapshot.";
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
      "The Docling Python package is not installed (required to convert PDFs to structured JSON).",
      "Run `pnpm setup:pdf` to install it.",
      DOCLING_DOCS
    );
  }
  if (ctx.exec(python, ["-c", VERSION_PROBE]).code !== 0) {
    return missing(
      `Docling is installed but not the pinned versions the structured adapter requires ` +
        `(docling==${PINNED_DOCLING_VERSION}, docling-core==${PINNED_DOCLING_CORE_VERSION}).`,
      DOCLING_PIN_REMEDY,
      DOCLING_DOCS
    );
  }
  if (ctx.exec(python, ["-c", MODEL_PROBE]).code !== 0) {
    return missing(
      `The pinned Docling model artifacts ` +
        `(${PINNED_MODEL_REPO}@${PINNED_MODEL_COMMIT}, tag ${PINNED_MODEL_TAG}) are not ` +
        `available locally (required for a reproducible, offline-ready conversion).`,
      MODEL_REMEDY,
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
    // Install the EXACT pinned runtime when it is not already present — the structured adapter's output
    // is only reproducible against these versions, so "some docling" is not enough.
    if (ctx.exec(python, ["-c", VERSION_PROBE]).code !== 0) {
      const pip = ctx.exec(python, [
        "-m",
        "pip",
        "install",
        `docling==${PINNED_DOCLING_VERSION}`,
        `docling-core==${PINNED_DOCLING_CORE_VERSION}`
      ]);
      if (pip.code !== 0) {
        return error(
          "`pip install docling` (pinned) failed.",
          withOutputTail(
            "Ensure pip is available (`python -m ensurepip --upgrade`) and check your network/proxy, then re-run `pnpm setup:pdf`.",
            pip
          ),
          DOCLING_DOCS
        );
      }
    }
    // Pre-fetch the pinned model snapshot so readiness means "offline-ready", not "will download on the
    // first conversion". Skipped when the snapshot is already cached.
    if (ctx.exec(python, ["-c", MODEL_PROBE]).code !== 0) {
      const download = ctx.exec(python, ["-c", MODEL_DOWNLOAD]);
      if (download.code !== 0) {
        return error(
          `Downloading the pinned Docling models ` +
            `(${PINNED_MODEL_REPO}@${PINNED_MODEL_COMMIT}, tag ${PINNED_MODEL_TAG}) failed.`,
          withOutputTail(
            "Check your network/proxy and Hugging Face access, then re-run `pnpm setup:pdf`.",
            download
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
