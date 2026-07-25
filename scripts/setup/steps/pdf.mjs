// Optional setup step (#510): make the PDF ingestion capability work end to end with one command —
// `pnpm setup:pdf`. A born-digital PDF is converted to structured JSON by the pinned Docling worker
// (#701) and published as canonical blocks (#702). A scanned/mixed PDF now imports too — English shipped
// in #745 and Chinese (Simplified and Traditional) in #746: the runner runs an OCRmyPDF/Tesseract
// pre-pass in the resolved Work/override language before conversion, so the text is recovered and the
// document publishes as one canonical Work.
//
// Because scanned/mixed OCR is a REAL import path, this step gates readiness on BOTH lanes:
//   - the born-digital prerequisites (Python, the pinned Docling runtime, the pinned model snapshot), and
//   - the OCR prerequisites (OCRmyPDF, Tesseract, and the exact trained-data packs every v0 Work language
//     needs: `eng`, `chi_sim`, `chi_tra`).
// Missing OCR tooling is a BLOCKING gap with a self-guiding remedy — never a silent informational line —
// so `pnpm setup:doctor` can never report the PDF capability ready while a scanned/mixed upload
// would fail at runtime with a typed tool/language-missing outcome (issues #745/#746 acceptance + the
// GUIDELINES setup gate for a shipped external tool). Provision installs what it safely can after
// explicit consent (Python + the Docling pip package + the model snapshot); the OCR system tools are
// left to the platform installers, so provision surfaces any OCR gap as the same blocking remedy rather
// than force-installing them. Excluded from the base `pnpm setup` (heavy/network); every failure mode
// returns an actionable { what, remedy }, never a raw crash.

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
  "https://ocrmypdf.readthedocs.io/en/latest/installation.html). " +
  "It provides the scanned-PDF OCR pre-pass and bundles Tesseract.";
const TESSERACT_DOCS = "https://tesseract-ocr.github.io/tessdoc/Installation.html";
const TESSERACT_REMEDY =
  "Install Tesseract OCR (`brew install tesseract` / `sudo apt install tesseract-ocr`, or on " +
  "Windows https://github.com/UB-Mannheim/tesseract/wiki).";
// The Tesseract trained-data packs the OCR lane needs across all three v0 Work languages (#746): English
// (`eng`), Simplified Chinese (`chi_sim`), and Traditional Chinese (`chi_tra`). In LOCKSTEP with the
// domain's `requiredTesseractTraineddata` for en/zh-CN/zh-TW — this .mjs cannot import the .ts, so the
// union of packs is duplicated here. English OCRs as `eng`; each Chinese variant pairs its script pack
// with `eng` for embedded Latin, so `eng` is required for every language. Verified individually (not by
// the binary's presence) so a Tesseract missing one pack is reported distinctly with its own remedy.
const REQUIRED_TESSERACT_PACKS = ["eng", "chi_sim", "chi_tra"];
const TESSERACT_PACK_LABELS = {
  eng: "English",
  chi_sim: "Simplified Chinese",
  chi_tra: "Traditional Chinese"
};
const TESSERACT_PACK_REMEDIES = {
  eng:
    "Install the English Tesseract language pack (`brew install tesseract-lang` / " +
    "`sudo apt install tesseract-ocr-eng`, or on Windows select English in the Tesseract installer).",
  chi_sim:
    "Install the Simplified Chinese Tesseract language pack (`brew install tesseract-lang` / " +
    "`sudo apt install tesseract-ocr-chi-sim`, or on Windows select Chinese (Simplified) in the " +
    "Tesseract installer).",
  chi_tra:
    "Install the Traditional Chinese Tesseract language pack (`brew install tesseract-lang` / " +
    "`sudo apt install tesseract-ocr-chi-tra`, or on Windows select Chinese (Traditional) in the " +
    "Tesseract installer)."
};

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

/**
 * Probe the BORN-DIGITAL PDF lane's prerequisites in order — Python, the Docling package, the pinned
 * runtime versions, then the pinned model snapshot — returning the FIRST gap distinctly (so the report
 * names exactly what is missing), or null when the born-digital lane is ready. Shared by `check` and
 * `verify` so a post-provision probe uses the same logic. OCR tooling is probed separately by
 * `probeOcrReadiness`; the step gates on BOTH via `pdfReadiness` (#745/#746).
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
  return null;
}

/**
 * The first required Tesseract trained-data pack that is NOT installed, or null when every pack the OCR
 * lane needs is present. Reads `--list-langs` once (it lists installed packs, one per line after a
 * header). A non-zero exit or empty output yields no confirmed packs, so the first required pack is
 * reported missing rather than assumed present.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string | null}
 */
function firstMissingTraineddata(ctx) {
  const result = ctx.exec("tesseract", ["--list-langs"]);
  const output = result.code !== 0 ? "" : `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const installed = new Set(output.split(/\r?\n/u).map((line) => line.trim()));
  return REQUIRED_TESSERACT_PACKS.find((pack) => !installed.has(pack)) ?? null;
}

/**
 * Probe the OCR lane's tooling (OCRmyPDF, the Tesseract it needs, then each required trained-data pack),
 * returning the first gap distinctly or null when all are present. Now that scanned/mixed OCR ships as a
 * real import path for English (#745) and Chinese (#746), the step gates on this alongside `probePdfLane`:
 * a missing OCR tool or pack marks the PDF capability not ready so setup/doctor never claims readiness
 * while a scanned/mixed upload would fail at runtime with a typed tool/language-missing outcome.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {import("../step.mjs").StepResult | null}
 */
export function probeOcrReadiness(ctx) {
  if (!ocrmypdfPresent(ctx)) {
    return missing(
      "OCRmyPDF was not found (needed by the scanned/mixed PDF OCR pre-pass, #745).",
      OCRMYPDF_REMEDY,
      OCRMYPDF_DOCS
    );
  }
  if (ctx.exec("tesseract", ["--version"]).code !== 0) {
    return missing(
      "Tesseract OCR was not found (OCRmyPDF needs it to read scanned pages, #745).",
      TESSERACT_REMEDY,
      TESSERACT_DOCS
    );
  }
  const missingPack = firstMissingTraineddata(ctx);
  if (missingPack !== null) {
    return missing(
      `The ${TESSERACT_PACK_LABELS[missingPack]} Tesseract trained-data pack ('${missingPack}') was ` +
        "not found (required to OCR scanned/mixed PDFs, #746).",
      TESSERACT_PACK_REMEDIES[missingPack],
      TESSERACT_DOCS
    );
  }
  return null;
}

/**
 * Combined PDF-capability readiness: the born-digital lane (Python/Docling/model) AND the OCR lane
 * (OCRmyPDF/Tesseract/`eng`+`chi_sim`+`chi_tra`) must both be present, because scanned/mixed PDF OCR
 * ships as a real import path for English (#745) and Chinese (#746). Returns the FIRST gap distinctly —
 * born-digital prerequisites first (the base every PDF needs), then the OCR tooling scanned/mixed pages
 * need — or null when the whole capability is ready. Shared by `check`, `provision`, and `verify` so
 * every phase gates identically and a missing OCR prerequisite is a loud, actionable remedy rather than a
 * silent informational line.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {import("../step.mjs").StepResult | null}
 */
export function pdfReadiness(ctx) {
  return probePdfLane(ctx) ?? probeOcrReadiness(ctx);
}

/** @type {import("../step.mjs").Step} */
export const pdfStep = {
  id: "pdf",
  title: "PDF ingestion (born-digital via Docling; English + Chinese OCR via OCRmyPDF #745/#746)",
  optional: true,
  capability: "pdf",
  check(ctx) {
    return pdfReadiness(ctx) ?? ok();
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
    // The OCR system tools (OCRmyPDF/Tesseract/`eng`+`chi_sim`+`chi_tra`) are platform installers this
    // step does not force-install; provision surfaces any remaining OCR gap as the same blocking,
    // self-guiding remedy (#745/#746) so the capability is never reported ready while a scanned/mixed
    // upload would fail.
    return pdfReadiness(ctx) ?? ok();
  },
  verify(ctx) {
    return pdfReadiness(ctx) ?? ok();
  }
};
