#!/usr/bin/env python3
"""Bounded structured PDF worker (#701): born-digital PDF -> validated DoclingDocument JSON.

The Node ``pdfStructuredAdapter`` spawns this one-shot worker, one child per operation, under a
per-range time ceiling (the parent kills on timeout) and a self-applied memory ceiling. It NEVER
emits Markdown and never defines a content model: it projects docling-core's DoclingDocument into the
adapter's ``whetstone-pdf-structured-range/1`` JSON contract (schema + geometry + provenance +
per-page native-text), and the Node side validates and concatenates ranges.

Two modes:

- ``--probe <file.pdf>``  -> ``{"pageCount": N, "pages": [...]}`` on stdout, where each page carries
  ``{pageNumber, width, height, rotation, hasNativeText}``. This lightweight classification (page
  geometry/rotation + native-text availability, no full Docling conversion) is the SOLE classifier
  #704 routes an OCR pre-pass on, and a later bounded OCR adapter (#755) validates OCR preserved. Encrypted input exits
  ``EXIT_PASSWORD_REQUIRED``; a broken file exits ``EXIT_CONVERSION_FAILED``.
- ``--range <file.pdf> <start> <end>`` -> one range payload JSON on stdout.

Reliability contract (mirrors the #403 markdown worker, kept in LOCKSTEP with pdfStructuredErrors.ts):

- Every Docling/OCR engine is DISABLED here (``do_ocr=False``): this is the born-digital slice, so a
  page with no native text is reported ``hasNativeText: false`` for #702/#704 to act on, never OCR'd.
- Output is UTF-8 regardless of host locale, so CJK/Greek text never raises ``UnicodeEncodeError`` on
  a cp1252 Windows console.
- Failures self-classify via exit code (missing dependency, conversion failed, password required,
  unsupported schema, memory, memory-ceiling-unsupported) — never a bare traceback as the only signal.
- The per-child memory ceiling is ENFORCED, not best-effort, through ONE worker-owned memory-boundary
  contract with a per-platform implementation (#782): POSIX applies an address-space ``RLIMIT_AS``; a
  supported Windows host applies a native Job Object memory limit (``JOB_OBJECT_LIMIT_PROCESS_MEMORY`` +
  ``JOB_OBJECT_LIMIT_JOB_MEMORY`` + ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``) via the pinned ``pywin32``,
  assigning this worker (and its descendants) before Docling/model construction. If a ceiling is
  requested but no boundary can be applied here (POSIX ``resource`` missing, or Windows without the
  pinned pywin32, or any Job Object create/configure/assign failure) the worker refuses with
  ``EXIT_MEMORY_CEILING_UNSUPPORTED`` instead of running unbounded — fail-closed, with an actionable
  setup remedy. ``--check-memory-ceiling`` exercises the real controller as a cheap readiness probe, and
  a successful run reports peak memory through a bounded metrics sidecar when ``WHETSTONE_PDF_METRICS_PATH``
  is set (Windows Job Object accounting; POSIX peak stays the harness's external RSS sampler).

Docling objects and real I/O are built behind ``build_converter`` / ``open_backend`` seams (mirroring
the whisper wrapper's ``model_loader``) so the mapping, payload, dispatch, and bounds logic is
unit-tested against fakes with no real models or network.

Permissive deps only: Docling + docling-core (MIT). OCR is disabled, not delegated.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence

# Exit codes — kept in LOCKSTEP with WORKER_EXIT_* in pdfStructuredErrors.ts. Changing one side
# requires changing the other; the Node adapter maps each to a named PdfStructuredFailure.
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_MISSING_DEPENDENCY = 3
EXIT_CONVERSION_FAILED = 4
EXIT_PASSWORD_REQUIRED = 5
EXIT_UNSUPPORTED_SCHEMA = 6
EXIT_MEMORY = 7
EXIT_MEMORY_CEILING_UNSUPPORTED = 8

RANGE_SCHEMA_VERSION = "whetstone-pdf-structured-range/1"
DOCLING_SCHEMA_NAME = "DoclingDocument"
# The docling-core DoclingDocument schema version(s) this worker understands. In LOCKSTEP with
# SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS in doclingDocument.ts (docling-core 2.87.1 emits "1.10.0").
SUPPORTED_SCHEMA_VERSIONS = ("1.10.0",)

MEMORY_LIMIT_ENV = "WHETSTONE_PDF_MEMORY_MIB"
# Optional sidecar path: when set, a successful run writes {"peakMemoryBytes": N} here (see
# write_metrics_sidecar). A SEPARATE channel from stdout so peak accounting never contaminates the
# range/probe JSON contract. Consumed by the #779 corpus harness.
METRICS_PATH_ENV = "WHETSTONE_PDF_METRICS_PATH"
# The ceiling (MiB) --check-memory-ceiling applies when no explicit WHETSTONE_PDF_MEMORY_MIB is set, so
# the probe always exercises the real controller. Mirrors the server's 2 GiB structured-memory default.
DEFAULT_PROBE_MEMORY_MIB = 2048


class PasswordRequired(Exception):
    """Raised when the PDF is encrypted and cannot be opened without a password."""


class UnsupportedSchema(Exception):
    """Raised when the converter emits a DoclingDocument schema version we do not support."""

    def __init__(self, version: str) -> None:
        super().__init__(f"unsupported DoclingDocument schema version: {version}")
        self.version = version


class ConversionFailed(Exception):
    """Raised for a genuine, file-level conversion failure (malformed/unreadable structure)."""


class MemoryCeilingUnsupported(Exception):
    """Raised when a memory ceiling is requested but no boundary can enforce one on this host.

    The bounded adapter (#701) promises a memory-bounded conversion, so an unenforceable ceiling is a
    hard refusal — never a silent unbounded run. This covers a POSIX host without ``resource``, a Windows
    host without the pinned pywin32 Job Object support, and any Job Object create/configure/assign failure.
    """

    def __init__(self, mib: int) -> None:
        super().__init__(
            f"a {mib} MiB per-child memory ceiling was requested but could not be enforced on this "
            "platform; no memory-boundary controller is available (on Windows run `pnpm setup:pdf` to "
            "install the pinned pywin32 Job Object support)"
        )
        self.mib = mib


class MemoryBoundary(Protocol):
    """A worker-owned, platform-native per-process memory ceiling — the one #782 boundary contract."""

    def apply(self, limit_bytes: int) -> None:
        """Enforce a hard ceiling of ``limit_bytes`` on this process and its descendants. Raise on failure."""

    def peak_bytes(self) -> Optional[int]:
        """Peak memory used under the ceiling, or None where this platform cannot cheaply report it."""


class _PosixMemoryBoundary:
    """Enforce a hard address-space ceiling with POSIX ``resource.setrlimit(RLIMIT_AS)`` (unchanged #701)."""

    def __init__(self, resource_module: Any) -> None:
        self._resource = resource_module

    def apply(self, limit_bytes: int) -> None:
        self._resource.setrlimit(self._resource.RLIMIT_AS, (limit_bytes, limit_bytes))

    def peak_bytes(self) -> Optional[int]:
        # POSIX peak accounting stays the harness's existing external RSS sampler (#782 "existing POSIX
        # accounting"); the worker emits no sidecar peak here.
        return None


class _WindowsMemoryBoundary:
    """Enforce a hard per-process/job memory ceiling with a Windows Job Object (pinned pywin32, #782).

    An UNNAMED Job Object is created, configured with process- and job-level memory limits plus
    KILL_ON_JOB_CLOSE, and THIS worker is assigned to it BEFORE Docling/model construction, so an
    oversized conversion (and any descendant it spawns) is bounded by the OS rather than left to swap. A
    worker already inside an outer job is placed in a NESTED job (no breakaway requested) on supported
    Windows. The handle is RETAINED for the worker lifetime so KILL_ON_JOB_CLOSE does not tear the job
    down early, and peak memory is read from the job's ``PeakJobMemoryUsed`` accounting.
    """

    def __init__(self, win32: Any) -> None:
        self._win32 = win32
        self._job: Any = None

    def apply(self, limit_bytes: int) -> None:
        win32 = self._win32
        job = win32.create_job_object()
        info = win32.query_extended_limit(job)
        basic = info["BasicLimitInformation"]
        basic["LimitFlags"] = (
            basic["LimitFlags"]
            | win32.JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | win32.JOB_OBJECT_LIMIT_JOB_MEMORY
            | win32.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        info["ProcessMemoryLimit"] = limit_bytes
        info["JobMemoryLimit"] = limit_bytes
        win32.set_extended_limit(job, info)
        win32.assign_current_process(job)
        # Retain the handle so the job (and its KILL_ON_JOB_CLOSE ceiling) lives for the worker lifetime.
        self._job = job

    def peak_bytes(self) -> Optional[int]:
        if self._job is None:
            return None
        info = self._win32.query_extended_limit(self._job)
        peak = info.get("PeakJobMemoryUsed")
        return int(peak) if peak else None


class _Win32JobApi:
    """Thin seam over pywin32's Job Object calls so ``_WindowsMemoryBoundary`` is testable against a fake."""

    def __init__(self, win32api: Any, win32job: Any) -> None:
        self._api = win32api
        self._job = win32job
        self.JOB_OBJECT_LIMIT_PROCESS_MEMORY = win32job.JOB_OBJECT_LIMIT_PROCESS_MEMORY
        self.JOB_OBJECT_LIMIT_JOB_MEMORY = win32job.JOB_OBJECT_LIMIT_JOB_MEMORY
        self.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

    def create_job_object(self) -> Any:
        return self._job.CreateJobObject(None, "")

    def query_extended_limit(self, job: Any) -> Any:
        return self._job.QueryInformationJobObject(job, self._job.JobObjectExtendedLimitInformation)

    def set_extended_limit(self, job: Any, info: Any) -> None:
        self._job.SetInformationJobObject(job, self._job.JobObjectExtendedLimitInformation, info)

    def assign_current_process(self, job: Any) -> None:
        self._job.AssignProcessToJobObject(job, self._api.GetCurrentProcess())


def _load_windows_job_api() -> Any:  # pragma: no cover - real pywin32; the seam is injected in tests.
    """Build the Job Object API adapter over pywin32, or None when pywin32 is not provisioned (Windows)."""
    try:
        import win32api  # type: ignore
        import win32job  # type: ignore
    except ImportError:
        return None
    return _Win32JobApi(win32api, win32job)


def resolve_memory_boundary(
    platform: str,
    posix_loader: Callable[[], Any] = None,  # type: ignore[assignment]
    windows_loader: Callable[[], Any] = None,  # type: ignore[assignment]
) -> Optional[MemoryBoundary]:
    """Resolve the ONE worker-owned memory-boundary for ``platform``, or None when none is available here.

    - ``win32``: a Job Object boundary when the pinned pywin32 is importable, else None (unsupported until
      ``pnpm setup:pdf`` installs it).
    - every other platform: the POSIX ``RLIMIT_AS`` boundary when ``resource`` is importable, else None.

    None means the ceiling cannot be enforced right now, so a requested ceiling is refused with
    ``EXIT_MEMORY_CEILING_UNSUPPORTED`` rather than run unbounded. Loaders are injected so tests drive the
    Windows and POSIX branches (and their missing-module case) without the real modules.
    """
    load_posix = _load_resource_module if posix_loader is None else posix_loader
    load_windows = _load_windows_job_api if windows_loader is None else windows_loader
    if platform == "win32":
        win32 = load_windows()
        return _WindowsMemoryBoundary(win32) if win32 is not None else None
    resource_module = load_posix()
    return _PosixMemoryBoundary(resource_module) if resource_module is not None else None


def apply_memory_limit(mib: Optional[str], boundary: Optional[MemoryBoundary]) -> None:
    """Self-apply the per-child memory ceiling through the platform ``boundary``, ENFORCED not best-effort.

    A non-numeric/absent/non-positive ``mib`` requests no ceiling and is a no-op. A positive ceiling with
    no available boundary (``boundary is None`` — POSIX without ``resource``, or Windows without pywin32)
    is a hard refusal: raise ``MemoryCeilingUnsupported`` rather than run unbounded. A boundary whose
    create/configure/assign fails is likewise surfaced as ``MemoryCeilingUnsupported`` — the #701
    memory-bounded invariant holds or the conversion refuses. Injected so tests drive every branch.
    """
    if mib is None:
        return
    try:
        limit_mib = int(mib)
    except (TypeError, ValueError):
        return
    if limit_mib <= 0:
        return
    if boundary is None:
        raise MemoryCeilingUnsupported(limit_mib)
    limit_bytes = limit_mib * 1024 * 1024
    try:
        boundary.apply(limit_bytes)
    except MemoryCeilingUnsupported:
        raise
    except Exception as error:  # noqa: BLE001 - any create/configure/assign failure is a hard refusal.
        raise MemoryCeilingUnsupported(limit_mib) from error


def write_metrics_sidecar(
    metrics_path: Optional[str],
    boundary: Optional[MemoryBoundary],
    opener: Callable[[str], Any] = None,  # type: ignore[assignment]
) -> None:
    """After a successful run, record the boundary's peak memory to the sidecar file, when both exist.

    The sidecar is a SEPARATE channel from stdout (which carries the range/probe JSON), so peak accounting
    never contaminates the conversion contract. Only a boundary that can cheaply report a peak (the
    Windows Job Object via ``PeakJobMemoryUsed``) writes a value; POSIX peak stays the harness's external
    RSS sampler. Absent path or peak -> no sidecar. A write failure is swallowed: metrics are diagnostics,
    never a reason to fail a good conversion. ``opener`` is injected so tests drive it without real I/O.
    """
    if metrics_path is None or boundary is None:
        return
    peak = boundary.peak_bytes()
    if peak is None:
        return
    open_file = _open_sidecar_for_write if opener is None else opener
    try:
        handle = open_file(metrics_path)
    except OSError:
        return
    try:
        handle.write(json.dumps({"peakMemoryBytes": int(peak)}))
    finally:
        handle.close()


def _open_sidecar_for_write(path: str) -> Any:  # pragma: no cover - trivial real-I/O seam, faked in tests.
    return open(path, "w", encoding="utf-8")


def _load_resource_module() -> Any:
    """Import the POSIX ``resource`` module, or None on platforms without it (Windows)."""
    try:  # pragma: no cover - platform-dependent import, exercised via injection in tests.
        import resource  # type: ignore

        return resource
    except ImportError:  # pragma: no cover - Windows path.
        return None


def build_converter() -> Any:  # pragma: no cover - real models; covered by the skip-guarded lane.
    """Build a Docling converter with every OCR engine disabled via its pipeline options.

    Imported lazily so a missing doc-AI lane surfaces as ImportError (classified as a missing
    dependency in ``run_range``) rather than a module-load crash. OCR is OFF because this is the
    born-digital slice (#701): scanned pages are reported, not OCR'd (that is #704's language-aware
    job).
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False

    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )


def open_backend(pdf_path: str) -> Any:  # pragma: no cover - real pypdfium2; skip-guarded lane.
    """Open the PDF with pypdfium2 (a Docling dependency) for page counting and native-text probing.

    An encrypted document raises ``pypdfium2.PdfiumError`` on load; ``count_pages`` translates that to
    ``PasswordRequired``. Kept behind this seam so the counting/probing logic tests against a fake.
    """
    import pypdfium2  # type: ignore

    return pypdfium2.PdfDocument(pdf_path)


def count_pages(pdf_path: str, opener: Callable[[str], Any]) -> int:
    """Count pages via the injected opener; translate an open/permission failure into a named error.

    A ``PasswordRequired`` bubbles up unchanged, and a missing PDF backend (``ImportError`` from the
    lazy ``pypdfium2``/docling import) bubbles up so the caller can classify it as a missing dependency
    rather than a corrupt file; any other open failure is a ``ConversionFailed`` so a corrupt file is a
    distinct exit from an encrypted one.
    """
    try:
        document = opener(pdf_path)
    except (PasswordRequired, ImportError):
        raise
    except Exception as error:  # noqa: BLE001 - classify any open failure, never crash raw.
        raise ConversionFailed(f"could not open PDF: {error}") from error
    return len(document)


def _prov(item: Any) -> Any:
    """First provenance record for an item, or None for a group/synthetic node without geometry."""
    prov = getattr(item, "prov", None)
    if not prov:
        return None
    return prov[0]


def _bounding_box_from(bbox: Any) -> dict[str, float]:
    """Project a docling BoundingBox (or None) to the contract's left/top/right/bottom floats."""
    if bbox is None:
        return {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
    return {
        "left": float(bbox.l),
        "top": float(bbox.t),
        "right": float(bbox.r),
        "bottom": float(bbox.b),
    }


def _bounding_box(prov: Any) -> dict[str, float]:
    """Project a docling ProvenanceItem bbox to the contract's left/top/right/bottom floats."""
    return _bounding_box_from(prov.bbox if prov is not None else None)


def _char_span(prov: Any) -> list[int]:
    """Project a ProvenanceItem char span to a [start, end] pair, defaulting to [0, 0]."""
    if prov is None:
        return [0, 0]
    span = getattr(prov, "charspan", None)
    if not span:
        return [0, 0]
    start, end = int(span[0]), int(span[1])
    return [start, end] if start <= end else [end, start]


def _page_number(prov: Any, default: int) -> int:
    """Page number from provenance (1-based), or the group's inherited default."""
    if prov is None:
        return default
    return int(getattr(prov, "page_no", default))


def _confidence(item: Any, page_confidences: dict[int, float], page_number: int) -> float:
    """Extraction confidence in [0, 1] as fallible EVIDENCE — never a drop reason.

    Prefer an item-level ``confidence`` when docling supplies one; otherwise fall back to the page's
    layout confidence (defaulting to 1.0 when unknown). Clamped to [0, 1].
    """
    raw = getattr(item, "confidence", None)
    if raw is None:
        raw = page_confidences.get(page_number, 1.0)
    value = float(raw)
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


def _table_cell_label(cell: Any) -> str:
    """Name a docling TableCell as the contract cell label the canonical mapper understands.

    A header cell (column or row header) becomes ``column_header`` / ``row_header`` so the mapper
    renders a ``tableHeader``; every other cell becomes a plain ``table_cell``.
    """
    if bool(getattr(cell, "column_header", False)):
        return "column_header"
    if bool(getattr(cell, "row_header", False)):
        return "row_header"
    return "table_cell"


def _table_cell_item(
    cell: Any, page_number: int, page_confidences: dict[int, float]
) -> dict[str, Any]:
    """Project one docling TableCell into a contract cell item under a ``table_row``."""
    return {
        "label": _table_cell_label(cell),
        "pageNumber": page_number,
        "boundingBox": _bounding_box_from(getattr(cell, "bbox", None)),
        "charSpan": [0, 0],
        "confidence": _confidence(cell, page_confidences, page_number),
        "text": str(getattr(cell, "text", "") or ""),
        "children": [],
    }


def _table_rows(
    item: Any, page_number: int, page_confidences: dict[int, float]
) -> Optional[list[dict[str, Any]]]:
    """Project a docling TableItem's ``data.table_cells`` grid into ordered ``table_row`` items.

    A docling ``TableItem`` carries NO ``children``; its cells live in ``data.table_cells`` keyed by
    grid offset. Group them by row (``start_row_offset_idx``), order each row by column
    (``start_col_offset_idx``), and emit the ``table_row`` -> cell contract shape the canonical mapper
    already turns into a PM ``table`` block. Returns ``None`` for any item that is not a populated
    table (no ``data.table_cells``) so ``map_item`` maps ``children`` the normal way instead.
    """
    data = getattr(item, "data", None)
    cells = getattr(data, "table_cells", None) if data is not None else None
    if not cells:
        return None
    by_row: dict[int, list[Any]] = {}
    for cell in cells:
        row_index = int(getattr(cell, "start_row_offset_idx", 0) or 0)
        by_row.setdefault(row_index, []).append(cell)
    rows: list[dict[str, Any]] = []
    for row_index in sorted(by_row):
        ordered = sorted(
            by_row[row_index],
            key=lambda cell: int(getattr(cell, "start_col_offset_idx", 0) or 0),
        )
        rows.append(
            {
                "label": "table_row",
                "pageNumber": page_number,
                "boundingBox": _bounding_box_from(None),
                "charSpan": [0, 0],
                "confidence": _confidence(item, page_confidences, page_number),
                "text": "",
                "children": [
                    _table_cell_item(cell, page_number, page_confidences) for cell in ordered
                ],
            }
        )
    return rows


def map_item(
    item: Any,
    doc: Any,
    resolve: Callable[[Any, Any], Any],
    page_confidences: dict[int, float],
    inherited_page: int,
) -> dict[str, Any]:
    """Project one DoclingDocument node (and its subtree) into a contract item.

    Layout order, labels, tables, and figures are fallible evidence: the raw docling ``label`` is kept
    verbatim (never narrowed to an enum), and low-confidence/unknown items are preserved with their
    geometry and provenance — nothing is silently dropped. Children are mapped recursively in order.
    A docling ``TableItem`` is special: it carries no ``children``, so its ``data.table_cells`` grid is
    projected into ordered ``table_row`` -> cell items (see ``_table_rows``) that the canonical mapper
    turns into a PM ``table`` block.
    """
    prov = _prov(item)
    page_number = _page_number(prov, inherited_page)
    table_rows = _table_rows(item, page_number, page_confidences)
    if table_rows is not None:
        children = table_rows
    else:
        children_refs = getattr(item, "children", None) or []
        children = [
            map_item(resolve(ref, doc), doc, resolve, page_confidences, page_number)
            for ref in children_refs
        ]
    return {
        "label": str(getattr(item, "label", "unknown")),
        "pageNumber": page_number,
        "boundingBox": _bounding_box(prov),
        "charSpan": _char_span(prov),
        "confidence": _confidence(item, page_confidences, page_number),
        "text": str(getattr(item, "text", "") or ""),
        "children": children,
    }


def map_group(
    group: Any,
    doc: Any,
    resolve: Callable[[Any, Any], Any],
    page_confidences: dict[int, float],
) -> list[dict[str, Any]]:
    """Map a top-level group's ordered children (body or furniture) into contract items."""
    children_refs = getattr(group, "children", None) or []
    return [
        map_item(resolve(ref, doc), doc, resolve, page_confidences, 1) for ref in children_refs
    ]


def _resolve_ref(ref: Any, doc: Any) -> Any:
    """Resolve a docling RefItem against the document; a plain node passes through unchanged."""
    resolver = getattr(ref, "resolve", None)
    return resolver(doc) if callable(resolver) else ref


def page_confidence_map(doc: Any) -> dict[int, float]:
    """Per-page layout confidence from docling's ConfidenceReport, when present; else empty.

    Absent/partial confidence is not an error — items fall back to 1.0. Any shape mismatch is ignored
    so a confidence report change never fails an otherwise good conversion.
    """
    confidences: dict[int, float] = {}
    report = getattr(doc, "confidence", None)
    pages = getattr(report, "pages", None)
    if not isinstance(pages, dict):
        return confidences
    for page_no, grade in pages.items():
        score = getattr(grade, "layout_score", None)
        if isinstance(score, (int, float)):
            confidences[int(page_no)] = float(score)
    return confidences


def clean_metadata_value(value: Any) -> Optional[str]:
    """Clean one raw PDF info-dictionary value: trim surrounding whitespace, and treat an empty (or
    non-string) value as absent (``None``) so a blank Title/Author never wins the resolution ladder."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed if trimmed else None


def build_document_metadata(raw: Mapping[str, Any]) -> dict[str, Optional[str]]:
    """Project the raw PDF info dictionary into the contract's cleaned ``{title, author}`` (#702).

    Both keys are always present; an absent, blank, or non-string field becomes ``None``. The Node
    ``pdfStructuredContracts`` schema expects this exact strict shape.
    """
    return {
        "title": clean_metadata_value(raw.get("Title")),
        "author": clean_metadata_value(raw.get("Author")),
    }


def pdf_metadata_reader(
    pdf_path: str, opener: Callable[[str], Any]
) -> Callable[[], Mapping[str, Any]]:  # pragma: no cover - real backend; cleaning tested via fake.
    """A document-metadata reader over the same pypdfium2 backend: reads the info-dictionary Title/Author.

    Kept behind this seam (mirroring ``native_text_prober``) so the cleaning/assembly logic tests against
    a fake and the real pypdfium2 read stays out of the coverage lane.
    """
    document = opener(pdf_path)

    def read() -> Mapping[str, Any]:
        return {
            "Title": document.get_metadata_value("Title"),
            "Author": document.get_metadata_value("Author"),
        }

    return read


def build_range_payload(
    doc: Any,
    start_page: int,
    end_page: int,
    native_text: Callable[[int], bool],
    metadata: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Assemble one range payload from a converted DoclingDocument.

    Rejects an unsupported schema version up front (``UnsupportedSchema``) so an incompatible converter
    is a named failure, not a silent misread. Preserves the ordered body/furniture trees and reports
    native-text availability for every page in [start_page, end_page]. When the caller supplies the raw
    PDF info dictionary, attaches its cleaned ``metadata`` (#702's title/author fallback source).
    """
    version = str(getattr(doc, "version", ""))
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise UnsupportedSchema(version)

    page_confidences = page_confidence_map(doc)
    pages = [
        {"pageNumber": page, "hasNativeText": bool(native_text(page))}
        for page in range(start_page, end_page + 1)
    ]
    payload: dict[str, Any] = {
        "schemaVersion": RANGE_SCHEMA_VERSION,
        "doclingSchema": {"name": DOCLING_SCHEMA_NAME, "version": version},
        "pages": pages,
        "body": map_group(getattr(doc, "body", None), doc, _resolve_ref, page_confidences),
        "furniture": map_group(getattr(doc, "furniture", None), doc, _resolve_ref, page_confidences),
    }
    if metadata is not None:
        payload["metadata"] = build_document_metadata(metadata)
    return payload


def convert_range(
    pdf_path: str,
    start_page: int,
    end_page: int,
    converter_factory: Callable[[], Any],
    native_text: Callable[[int], bool],
    read_metadata: Optional[Callable[[], Mapping[str, Any]]] = None,
) -> dict[str, Any]:
    """Convert one bounded page range to a range payload using a converter from ``converter_factory``.

    Docling's ``convert`` receives an explicit ``page_range`` so only the requested pages are decoded.
    When a ``read_metadata`` seam is supplied, its raw PDF info dictionary is cleaned onto the payload.
    """
    converter = converter_factory()
    result = converter.convert(pdf_path, page_range=(start_page, end_page))
    metadata = read_metadata() if read_metadata is not None else None
    return build_range_payload(result.document, start_page, end_page, native_text, metadata)


def native_text_prober(pdf_path: str, opener: Callable[[str], Any]) -> Callable[[int], bool]:
    """A per-page native-text predicate: true when the page's text layer yields characters.

    Uses the same backend as the page count. A page with zero extractable characters is image-only
    (``hasNativeText: false``) — reported, never OCR'd, in this born-digital slice.
    """
    document = opener(pdf_path)  # pragma: no cover - real backend; logic below tested via fake.

    def has_text(page_number: int) -> bool:  # pragma: no cover - real backend page access.
        page = document[page_number - 1]
        textpage = page.get_textpage()
        return textpage.count_chars() > 0

    return has_text


def page_geometry_prober(
    pdf_path: str, opener: Callable[[str], Any]
) -> Callable[[int], Mapping[str, float]]:
    """A per-page geometry predicate: the page's box (width/height in PDF points) and quarter-turn rotation.

    Uses the same backend as the page count. Reported by ``--probe`` so #704 can validate that a later
    OCR pre-pass (#755) preserved page geometry and rotation without a full Docling conversion.
    """
    document = opener(pdf_path)  # pragma: no cover - real backend; logic below tested via fake.

    def geometry(page_number: int) -> Mapping[str, float]:  # pragma: no cover - real backend page access.
        page = document[page_number - 1]
        width, height = page.get_size()
        return {
            "width": float(width),
            "height": float(height),
            "rotation": int(page.get_rotation()),
        }

    return geometry


def _write(stream: Any, text: str) -> None:
    """Write ``text`` as UTF-8, bypassing the host locale codec when the stream exposes a buffer."""
    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        buffer.write(text.encode("utf-8"))
        buffer.flush()
    else:
        stream.write(text)


def run_probe(
    pdf_path: str,
    opener: Callable[[str], Any],
    prober_factory: Callable[[str], Callable[[int], bool]],
    geometry_factory: Callable[[str], Callable[[int], Mapping[str, float]]],
    stdout: Any,
    stderr: Any,
) -> int:
    """``--probe`` mode: emit the page count AND per-page geometry/rotation/native-text.

    This is the SOLE lightweight classifier #704 routes an OCR pre-pass on (a scanned/mixed document is
    detected here, so it never pays for a disposable pre-OCR Docling conversion) and a later bounded OCR
    adapter (#755) validates OCR preserved. Encryption, a missing toolchain, and corruption classify to distinct exit codes.
    """
    try:
        page_count = count_pages(pdf_path, opener)
        native_text = prober_factory(pdf_path)
        geometry = geometry_factory(pdf_path)
        pages = []
        for page_number in range(1, page_count + 1):
            box = geometry(page_number)
            pages.append(
                {
                    "pageNumber": page_number,
                    "width": float(box["width"]),
                    "height": float(box["height"]),
                    "rotation": int(box["rotation"]),
                    "hasNativeText": bool(native_text(page_number)),
                }
            )
    except PasswordRequired:
        _write(stderr, "pdf is encrypted; a password is required to open it.\n")
        return EXIT_PASSWORD_REQUIRED
    except ImportError as error:
        _write(
            stderr,
            f"pdf tooling is not installed ({error}); run `pnpm setup:pdf` to enable PDF ingestion.\n",
        )
        return EXIT_MISSING_DEPENDENCY
    except Exception as error:  # noqa: BLE001 - classify any open/geometry failure, never crash raw.
        _write(stderr, f"pdf probe failed for {pdf_path}: {error}\n")
        return EXIT_CONVERSION_FAILED
    _write(stdout, json.dumps({"pageCount": page_count, "pages": pages}))
    return EXIT_OK


def run_range(
    pdf_path: str,
    start_page: int,
    end_page: int,
    converter_factory: Callable[[], Any],
    prober_factory: Callable[[str], Callable[[int], bool]],
    stdout: Any,
    stderr: Any,
    metadata_reader_factory: Optional[
        Callable[[str], Callable[[], Mapping[str, Any]]]
    ] = None,
) -> int:
    """``--range`` mode: emit one validated range payload, classifying each failure distinctly.

    When a ``metadata_reader_factory`` is wired, the payload carries the source PDF's cleaned document
    metadata (#702's title/author fallback); without one it is simply omitted (an older/metadata-less run).
    """
    try:
        native_text = prober_factory(pdf_path)
        read_metadata = (
            metadata_reader_factory(pdf_path) if metadata_reader_factory is not None else None
        )
        payload = convert_range(
            pdf_path, start_page, end_page, converter_factory, native_text, read_metadata
        )
    except PasswordRequired:
        _write(stderr, "pdf is encrypted; a password is required to open it.\n")
        return EXIT_PASSWORD_REQUIRED
    except UnsupportedSchema as error:
        _write(stderr, f"unsupported DoclingDocument schema version: {error.version}\n")
        return EXIT_UNSUPPORTED_SCHEMA
    except ImportError as error:
        _write(
            stderr,
            f"pdf tooling is not installed ({error}); run `pnpm setup:pdf` to enable PDF ingestion.\n",
        )
        return EXIT_MISSING_DEPENDENCY
    except Exception as error:  # noqa: BLE001 - classify any conversion failure, never crash raw.
        _write(stderr, f"pdf conversion failed for {pdf_path}: {error}\n")
        return EXIT_CONVERSION_FAILED
    _write(stdout, json.dumps(payload, ensure_ascii=False))
    return EXIT_OK


def _parse_positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise ValueError("page numbers are 1-based and positive")
    return number


def run_check_memory_ceiling(
    mib: Optional[str], boundary: Optional[MemoryBoundary], stdout: Any, stderr: Any
) -> int:
    """``--check-memory-ceiling``: exercise the real platform controller and report readiness.

    The cheap capability probe setup (#510) and the #779 harness call BEFORE any conversion. It actually
    creates/configures/assigns the platform boundary (a Job Object on Windows, ``RLIMIT_AS`` on POSIX)
    against THIS process, so "ready" means the mechanism works here — not merely that a module imports or
    that the platform name looks supported. A ceiling that cannot be enforced returns
    ``EXIT_MEMORY_CEILING_UNSUPPORTED``; success prints the enforced ceiling as JSON and returns
    ``EXIT_OK``. When no ceiling is configured the probe applies ``DEFAULT_PROBE_MEMORY_MIB`` so it always
    exercises the controller.
    """
    try:
        limit_mib = int(mib) if mib is not None else DEFAULT_PROBE_MEMORY_MIB
    except (TypeError, ValueError):
        limit_mib = DEFAULT_PROBE_MEMORY_MIB
    if limit_mib <= 0:
        limit_mib = DEFAULT_PROBE_MEMORY_MIB
    try:
        apply_memory_limit(str(limit_mib), boundary)
    except MemoryCeilingUnsupported as error:
        _write(stderr, f"{error}\n")
        return EXIT_MEMORY_CEILING_UNSUPPORTED
    _write(stdout, json.dumps({"ceilingEnforced": True, "memoryMib": limit_mib}))
    return EXIT_OK


def main(
    argv: Optional[Sequence[str]] = None,
    converter_factory: Callable[[], Any] = build_converter,
    opener: Callable[[str], Any] = open_backend,
    prober_factory: Optional[Callable[[str], Callable[[int], bool]]] = None,
    geometry_factory: Optional[
        Callable[[str], Callable[[int], Mapping[str, float]]]
    ] = None,
    boundary: Any = "__default__",
    platform: Optional[str] = None,
    stdout: Any = None,
    stderr: Any = None,
    metadata_reader_factory: Optional[
        Callable[[str], Callable[[], Mapping[str, Any]]]
    ] = None,
    metrics_writer: Callable[..., None] = write_metrics_sidecar,
) -> int:
    """Parse args, apply the memory ceiling through the platform boundary, and dispatch the requested mode."""
    argv = sys.argv[1:] if argv is None else list(argv)
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    resolved_platform = sys.platform if platform is None else platform
    if boundary == "__default__":
        boundary = resolve_memory_boundary(resolved_platform)
    if prober_factory is None:
        prober_factory = lambda path: native_text_prober(path, opener)
    if geometry_factory is None:
        geometry_factory = lambda path: page_geometry_prober(path, opener)
    if metadata_reader_factory is None:
        metadata_reader_factory = lambda path: pdf_metadata_reader(path, opener)

    # The readiness probe exercises the real controller itself, so it precedes (and does not double-apply)
    # the startup ceiling.
    if len(argv) == 1 and argv[0] == "--check-memory-ceiling":
        return run_check_memory_ceiling(os.environ.get(MEMORY_LIMIT_ENV), boundary, stdout, stderr)

    try:
        apply_memory_limit(os.environ.get(MEMORY_LIMIT_ENV), boundary)
    except MemoryCeilingUnsupported as error:
        _write(stderr, f"{error}\n")
        return EXIT_MEMORY_CEILING_UNSUPPORTED

    try:
        if len(argv) == 2 and argv[0] == "--probe":
            code = run_probe(argv[1], opener, prober_factory, geometry_factory, stdout, stderr)
        elif len(argv) == 4 and argv[0] == "--range":
            start_page = _parse_positive_int(argv[2])
            end_page = _parse_positive_int(argv[3])
            if end_page < start_page:
                raise ValueError("end page must be >= start page")
            code = run_range(
                argv[1],
                start_page,
                end_page,
                converter_factory,
                prober_factory,
                stdout,
                stderr,
                metadata_reader_factory,
            )
        else:
            _write(
                stderr,
                "usage: pdf_to_docling.py --probe <file.pdf> | --range <file.pdf> <start> <end> | "
                "--check-memory-ceiling\n",
            )
            return EXIT_USAGE
    except ValueError as error:
        _write(stderr, f"usage error: {error}\n")
        return EXIT_USAGE

    # Emit the bounded peak-memory sidecar only for a successful conversion, so a failure's partial peak is
    # never mistaken for a completed run's metric.
    if code == EXIT_OK:
        metrics_writer(os.environ.get(METRICS_PATH_ENV), boundary)
    return code


def _entrypoint() -> int:  # pragma: no cover - process entry
    try:
        return main()
    except ImportError:
        sys.stderr.write("docling is not installed; run `pnpm setup:pdf` to enable PDF ingestion.\n")
        return EXIT_MISSING_DEPENDENCY
    except MemoryError:
        sys.stderr.write("pdf conversion exceeded its memory ceiling.\n")
        return EXIT_MEMORY


if __name__ == "__main__":  # pragma: no cover - process entry
    sys.exit(_entrypoint())
