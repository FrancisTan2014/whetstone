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
- Failures self-classify via exit code (missing dependency, conversion failed, conversion incomplete,
  password required, unsupported schema, memory, memory-ceiling-unsupported) — never a bare traceback as
  the only signal.
- A conversion is trusted ONLY when Docling reports an unqualified ``SUCCESS`` (#832) AND its own per-page
  record covers every requested page (#840). Docling keeps going when individual pages fail: it returns
  ``PARTIAL_SUCCESS`` with a document holding only the pages that survived, and reports the rest on
  ``result.errors``. Reading just ``result.document`` therefore emits a fragment as an ordinary range
  payload, which is later committed and published as a whole book. So the
  status IS the contract here: anything other than ``SUCCESS`` exits ``EXIT_CONVERSION_INCOMPLETE`` with
  the failed page numbers and Docling's own reason on stderr, and no payload at all. Standing behind that
  status, ``ConversionResult.pages`` records what the converter actually PROCESSED, page by page. It is
  NOT an independent channel: in pinned docling the status is DERIVED from that same list (a failed page
  is dropped from ``pages`` and appended to ``errors``, and any error downgrades ``SUCCESS``), so for
  in-document page loss the two agree by construction. What the record adds is that it is checked against
  the window this range REQUESTED, which the status cannot see — asked for pages 461-470 of the real
  462-page book, docling clamps to 461-462 and still reports ``SUCCESS`` with zero errors (measured), and
  only the record catches it — and that a future converter that claims success while silently
  under-producing cannot publish a fragment either. Both gates FAIL CLOSED: a result that reports no
  status, and a result carrying no per-page record, are refused too, because a conversion whose
  completeness cannot be checked is not a complete conversion. Neither judges completeness from what a
  page PRODUCED — an item count was measured to be zero for pages that converted perfectly
  (``docs/DECISIONS.md`` D8).
- Two page-count authorities exist for one file and are never reconciled: ``count_pages`` (and so every
  range this worker is asked for) counts with pypdfium2, ``len(PdfDocument)``, while docling clamps a
  requested range with its own document backend's ``page_count()`` — a docling-parse count, which that
  backend logs as "Inconsistent number of pages" when it disagrees with pypdfium2's. They agree on the
  real book (462 both ways). If they ever diverge, the last range overshoots what docling will convert
  and the per-page gate above refuses the import: the product-correct outcome under "complete or
  refused", and the first place to look if a whole book starts refusing on its final range.
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

import hashlib
import io
import json
import os
import sys
import tempfile
from typing import Any, Callable, Iterator, Mapping, Optional, Protocol, Sequence

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
EXIT_CONVERSION_INCOMPLETE = 9

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

# The docling labels whose item may carry a renderable picture (#807), matched to PICTURE_LABELS in
# pdfCanonicalMapping.ts. Only a body item with one of these labels is offered to the artifact sink.
PICTURE_LABELS = frozenset({"picture", "figure"})
# The per-picture PNG byte ceiling. A rendered picture larger than this is left ref-less (it maps to a
# #806 unresolved placeholder) so no single artifact can dominate the attempt's byte budget. In lockstep
# with MAX_ARTIFACT_BYTES in pdfImportArtifacts.ts, which re-checks it on the server before adoption.
MAX_PICTURE_ARTIFACT_BYTES = 16 * 1024 * 1024

# Bounds on the imported PDF bookmark outline (#815). The outline is the author's DECLARED heading
# hierarchy, so it is read once per invocation and carried as ordinary extraction evidence — but it comes
# from an untrusted file, so it is bounded here rather than trusted: a corpus probe of 186 real PDFs found
# a median of 150 entries and a maximum of 985, so 5,000 entries admits every real book while refusing a
# pathological or hostile bookmark tree, and 512 characters admits every real bookmark title.
MAX_OUTLINE_ENTRIES = 5000
MAX_OUTLINE_TITLE_CHARS = 512
# How deep pypdfium2 walks the bookmark tree. The same corpus probe found a maximum nesting depth of 6,
# and the canonical heading model only has six levels, so this is generous headroom that still bounds the
# recursion over a maliciously deep tree.
MAX_OUTLINE_DEPTH = 15

# How many distinct Docling error messages and failed page numbers a ``ConversionIncomplete`` reason
# quotes (#832). A degraded conversion can report a failure for every page in the range, and the reason
# is written to the child's stderr and carried into an attempt's stored failure, so it is bounded: the
# operator needs the shape of the failure and a sample, not 3,000 repetitions of one message.
MAX_REPORTED_CONVERSION_ERRORS = 3
MAX_REPORTED_FAILED_PAGES = 20


class PasswordRequired(Exception):
    """Raised when the PDF is encrypted and cannot be opened without a password."""


class UnsupportedSchema(Exception):
    """Raised when the converter emits a DoclingDocument schema version we do not support."""

    def __init__(self, version: str) -> None:
        super().__init__(f"unsupported DoclingDocument schema version: {version}")
        self.version = version


class ConversionFailed(Exception):
    """Raised for a genuine, file-level conversion failure (malformed/unreadable structure)."""


class ConversionIncomplete(Exception):
    """Raised when a range did not fully convert: a DEGRADED status (#832) or a page with no evidence (#840).

    Docling does not stop when a page fails: it records the failure on ``result.errors``, sets
    ``result.status`` to ``PARTIAL_SUCCESS`` (or ``FAILURE``), and still returns a ``document`` — one that
    contains only the pages that survived. Building a payload from that document emits a FRAGMENT that is
    indistinguishable from a good range, so the range is committed and the book is published ~90% empty
    while every gate reports success. The degraded status is therefore a hard refusal here, never a
    payload: the caller gets the reported page numbers and Docling's own reason instead.

    The same refusal carries the #840 backstop, because the outcome is identical — pages were lost and no
    payload may be built. There, ``status`` is what the converter CLAIMED (an unqualified success, since
    the status gate ran first) and ``failed_pages`` are the requested pages its own per-page record does
    not account for. One failure vocabulary, so an operator and the adapter see "this range lost pages"
    however it was detected.
    """

    def __init__(self, status: str, failed_pages: Sequence[int], reason: str) -> None:
        super().__init__(
            f"docling reported {status} for this page range; "
            f"{len(failed_pages)} page(s) failed to convert: {reason}"
        )
        self.status = status
        self.failed_pages = list(failed_pages)
        self.reason = reason


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

    def release(self) -> None:
        """Relax teardown-time enforcement on the orderly exit path so the worker's own exit code survives.

        Called once from ``main`` immediately before the worker returns its code (#843). The MEMORY ceiling
        itself is never relaxed, and any handle ``peak_bytes`` still reads stays open — only enforcement
        that would outlive the decision and overwrite it is stood down.
        """


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

    def release(self) -> None:
        # RLIMIT_AS is a per-process ceiling with no teardown behaviour: it bounds allocation and then dies
        # with the process, so it can never overwrite the exit status. Nothing to stand down here (#843).
        return None


class _WindowsMemoryBoundary:
    """Enforce a hard per-process/job memory ceiling with a Windows Job Object (pinned pywin32, #782).

    An UNNAMED Job Object is created, configured with process- and job-level memory limits plus
    KILL_ON_JOB_CLOSE, and THIS worker is assigned to it BEFORE Docling/model construction, so an
    oversized conversion (and any descendant it spawns) is bounded by the OS rather than left to swap. A
    worker already inside an outer job is placed in a NESTED job (no breakaway requested) on supported
    Windows. The handle is RETAINED for the worker lifetime so KILL_ON_JOB_CLOSE does not tear the job
    down early, and peak memory is read from the job's ``PeakJobMemoryUsed`` accounting.

    KILL_ON_JOB_CLOSE is stood down by ``release`` on the orderly exit path (#843): the retained handle is
    dropped at interpreter shutdown, and a job that sees its last handle close TERMINATES the processes
    still assigned to it — this one. That kill landed after ``sys.exit(code)`` and overwrote the worker's
    status with the job's, so every classified failure reached the adapter as 0.
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

    def release(self) -> None:
        """Clear ONLY KILL_ON_JOB_CLOSE so shutdown cannot overwrite the exit code the worker chose (#843).

        The flag guards the whole run — it is what stops a runaway descendant outliving the worker — so it
        is cleared here, at the orderly exit, and not dropped from ``apply``. The two memory-limit flags and
        both limits are left exactly as configured, so the job stays bounded until the process is gone. The
        handle is deliberately NOT closed: ``peak_bytes`` still reads ``PeakJobMemoryUsed`` from it for the
        metrics sidecar.
        """
        if self._job is None:
            return
        win32 = self._win32
        info = win32.query_extended_limit(self._job)
        basic = info["BasicLimitInformation"]
        basic["LimitFlags"] = basic["LimitFlags"] & ~win32.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        win32.set_extended_limit(self._job, info)


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


def release_memory_boundary(boundary: Optional[MemoryBoundary]) -> None:
    """Stand the boundary's teardown-time enforcement down on the orderly exit path — BEST EFFORT (#843).

    Called once from ``main`` after the worker has decided its exit code and before it returns, so no
    platform teardown can overwrite that code (on Windows the Job Object's KILL_ON_JOB_CLOSE did exactly
    that, collapsing every classified failure to 0). It can never CHANGE the decided code: no boundary is a
    no-op, and a boundary whose release fails is swallowed — a best-effort cleanup must not become a new
    failure mode, and the memory ceiling it enforced is bounded by the process ending either way.
    """
    if boundary is None:
        return
    try:
        boundary.release()
    except Exception:  # noqa: BLE001 - never let a cleanup rewrite the outcome the worker reported.
        pass


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
    # Render each detected picture to a raster image so its bytes can be preserved as a canonical figure
    # (#807). Page images and table images stay OFF: we only need the picture crops, not full-page renders.
    pipeline_options.generate_picture_images = True
    pipeline_options.images_scale = 2.0

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


def _ordered_span(start: int, end: int) -> list[int]:
    """Order a char-span pair so ``start <= end`` — the contract's charSpan invariant, in one place."""
    return [start, end] if start <= end else [end, start]


def _char_span(prov: Any) -> list[int]:
    """Project a ProvenanceItem char span to a [start, end] pair, defaulting to [0, 0]."""
    if prov is None:
        return [0, 0]
    span = getattr(prov, "charspan", None)
    if not span:
        return [0, 0]
    return _ordered_span(int(span[0]), int(span[1]))


def _page_number(prov: Any, default: int) -> int:
    """Page number from provenance (1-based), or the group's inherited default."""
    if prov is None:
        return default
    return int(getattr(prov, "page_no", default))


def _subtree_provs(item: Any, doc: Any, resolve: Callable[[Any, Any], Any]) -> Iterator[Any]:
    """Yield the first provenance record of every node in ``item``'s subtree, in pre-order (document) order."""
    prov = _prov(item)
    if prov is not None:
        yield prov
    for ref in getattr(item, "children", None) or []:
        yield from _subtree_provs(resolve(ref, doc), doc, resolve)


def _borrowed_geometry(
    item: Any, doc: Any, resolve: Callable[[Any, Any], Any], fallback_page: int
) -> Optional[tuple[int, dict[str, float], list[int]]]:
    """Page/box/span a provenance-LESS node borrows from the content it holds, or None (#813).

    A docling group (``list``, ``inline``, ...) carries no ``prov`` of its own, so left to a constant it
    would claim a page its content is not on — evidence that describes no source, which is worse than
    no evidence. It borrows page and bounding box from the FIRST descendant with provenance in document
    order, and a char span running from that descendant's start to the LAST descendant's end ON THAT
    SAME PAGE, so the span stays a coherent single-page range and no box is synthesized across pages.

    Returns None when nothing in the subtree carries provenance — the caller then keeps its inherited
    fallback page and a zero-area box.
    """
    provs = _subtree_provs(item, doc, resolve)
    first = next(provs, None)
    if first is None:
        return None
    page = _page_number(first, fallback_page)
    start, end = _char_span(first)
    for prov in provs:
        if _page_number(prov, fallback_page) == page:
            end = _char_span(prov)[1]
    return page, _bounding_box(first), _ordered_span(start, end)


def _resolve_geometry(
    item: Any, doc: Any, resolve: Callable[[Any, Any], Any], inherited_page: int
) -> tuple[int, dict[str, float], list[int]]:
    """Resolve the (page, bounding box, char span) evidence one node reports.

    A node with provenance of its own is resolved from it, unchanged. A node WITHOUT provenance — every
    docling group — borrows from the content it holds (``_borrowed_geometry``). Only when nothing in its
    subtree carries provenance either does it fall back to ``inherited_page`` with a zero-area box: the
    range's first page at the top level, the enclosing item's resolved page deeper in — never the
    constant page 1 (#813).
    """
    prov = _prov(item)
    if prov is not None:
        return _page_number(prov, inherited_page), _bounding_box(prov), _char_span(prov)
    borrowed = _borrowed_geometry(item, doc, resolve, inherited_page)
    if borrowed is not None:
        return borrowed
    return inherited_page, _bounding_box(None), _char_span(None)


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


# The docling ``DocItemLabel`` value a code listing's mapped item carries (``map_item``'s own
# ``label`` variable is always this exact string for a code item — see #815/#811 for the same
# raw-label-comparison style applied to headings/furniture).
CODE_CLUSTER_LABEL = "code"

# Half a point summed across all four bbox coordinates: generous enough to absorb any floating-point
# accumulation from the coordinate-origin round trip (see ``_cluster_bbox_bottom_left``), far below
# the scale (tens of points) that would indicate two genuinely different clusters on the same page.
CODE_CLUSTER_MATCH_TOLERANCE = 0.5


def _cluster_code_lines(cluster: Any) -> Optional[str]:
    """One CODE layout cluster's per-line text, joined with real newlines and indentation intact (#876).

    Docling's OWN page-assembly step (``PageAssembleModel.__call__``) builds this exact same list from
    ``cluster.cells`` but calls ``.strip()`` on every line before joining them with a single space —
    correct for a prose paragraph, and the reason every code listing is flattened to one line with its
    indentation gone (measured: 520 of 520 `codeBlock`s, 0 containing a newline). Reusing docling's own
    blank-line filter (skip a cell that is blank after stripping) but keeping each SURVIVING cell's
    original, unstripped text reconstructs the listing exactly as extracted — the indentation was never
    lost upstream of this cluster, only downstream of it. Returns ``None`` when the cluster carries no
    non-blank cell, so the caller falls back to the flattened ``item.text`` rather than emit an empty
    block (#876's mandatory fallback).
    """
    lines = [
        str(getattr(cell, "text", "") or "").replace("\x02", "-")
        for cell in getattr(cluster, "cells", None) or []
        if str(getattr(cell, "text", "") or "").strip() != ""
    ]
    return "\n".join(lines) if lines else None


def _cluster_bbox_bottom_left(bbox: Any, page_height: float) -> dict[str, float]:
    """A layout cluster's bounding box, converted from its native top-left origin to the SAME
    bottom-left origin the final document item's own provenance bbox carries.

    Docling's reading-order stage builds a ``CodeItem``'s provenance as
    ``cluster.bbox.to_bottom_left_origin(page_height)`` (left/right unchanged, top/bottom mirrored
    through the page height, origin relabelled). Reproducing that exact arithmetic here lets a cluster
    be matched against the mapped item's own ``boundingBox`` (``_bounding_box_from``'s identical
    ``{left, top, right, bottom}`` shape) without depending on docling's own conversion helper or
    constructing a real ``BoundingBox``.
    """
    return {
        "left": float(bbox.l),
        "right": float(bbox.r),
        "top": page_height - float(bbox.t),
        "bottom": page_height - float(bbox.b),
    }


def build_code_cluster_index(result: Any) -> dict[int, list[tuple[dict[str, float], str]]]:
    """Every CODE-labelled layout cluster's reconstructed text, keyed by the 1-based page it is on (#876).

    ``ConversionResult.pages[*].predictions.layout.clusters`` is the converter's own per-page layout
    record — never released after assembly (only ``parsed_page`` and the page backend are, when
    ``generate_parsed_pages`` is off, which this worker's converter leaves at its default) — and the
    ONLY place a code listing's per-line breakdown with its original indentation still exists; the
    document item docling ultimately builds carries just the one space-joined string this index is
    used to replace (see ``map_item``). Fails soft at every level (missing/invalid page number,
    predictions/layout/size/bbox), exactly like ``page_confidence_map``, since a code-formatting
    improvement must never turn a missing or unexpected docling field into a conversion failure — an
    empty result here just means every code item falls back to its flattened text, today's existing
    behavior. Reuses ``_evidence_page_number``'s exact page-number validity rule (#840) so the same
    entry is never trusted as a page here that ``processed_page_numbers`` would refuse to count.
    """
    index: dict[int, list[tuple[dict[str, float], str]]] = {}
    for page in getattr(result, "pages", None) or []:
        page_no = _evidence_page_number(page)
        if page_no is None:
            continue
        size = getattr(page, "size", None)
        page_height = getattr(size, "height", None) if size is not None else None
        if not isinstance(page_height, (int, float)) or isinstance(page_height, bool):
            continue
        predictions = getattr(page, "predictions", None)
        layout = getattr(predictions, "layout", None) if predictions is not None else None
        clusters = getattr(layout, "clusters", None) if layout is not None else None
        entries: list[tuple[dict[str, float], str]] = []
        for cluster in clusters or []:
            if str(getattr(cluster, "label", "")) != CODE_CLUSTER_LABEL:
                continue
            bbox = getattr(cluster, "bbox", None)
            if bbox is None:
                continue
            text = _cluster_code_lines(cluster)
            if text is None:
                continue
            entries.append((_cluster_bbox_bottom_left(bbox, float(page_height)), text))
        if entries:
            index[page_no] = entries
    return index


def _match_code_cluster_text(
    bounding_box: dict[str, float], candidates: Sequence[tuple[dict[str, float], str]]
) -> Optional[str]:
    """The reconstructed text of whichever candidate cluster's bbox is closest to ``bounding_box``, or
    ``None`` when nothing is close enough to trust (#876's mandatory fallback: a code item is never
    emitted empty because its cluster could not be found). Ties resolve to the first closest candidate;
    real code listings on one page never share a bounding box, so a tie never arises in practice.
    """
    best_text: Optional[str] = None
    best_distance = CODE_CLUSTER_MATCH_TOLERANCE
    for candidate_box, text in candidates:
        distance = (
            abs(candidate_box["left"] - bounding_box["left"])
            + abs(candidate_box["top"] - bounding_box["top"])
            + abs(candidate_box["right"] - bounding_box["right"])
            + abs(candidate_box["bottom"] - bounding_box["bottom"])
        )
        if distance <= best_distance:
            best_distance = distance
            best_text = text
    return best_text


def _picture_image_reader(item: Any, doc: Any) -> Any:
    """Render a docling picture item to a PIL image, or None when it carries no renderable image.

    The real seam over ``PictureItem.get_image(document)`` (which returns a PIL image when
    ``generate_picture_images`` is on, else None). Kept tiny and injectable so the extraction/manifest
    logic tests against a fake item without real docling models.
    """
    getter = getattr(item, "get_image", None)
    if getter is None:
        return None
    return getter(doc)


class ArtifactSink:
    """Collects rendered picture artifacts into a server-owned range directory (#807).

    Holds the destination directory, the image-reader seam, and the per-picture byte ceiling, and hands
    out a stable, collision-free file name per extracted picture. The bytes are written into the
    directory the server prepared for this range; only a manifest ref (never the bytes) is returned to
    the JSON contract.
    """

    def __init__(
        self,
        directory: str,
        read_image: Callable[[Any, Any], Any],
        max_bytes: int = MAX_PICTURE_ARTIFACT_BYTES,
    ) -> None:
        self.directory = directory
        self.read_image = read_image
        self.max_bytes = max_bytes
        self._next_index = 0

    def next_name(self) -> str:
        name = f"fig-{self._next_index}.png"
        self._next_index += 1
        return name


def _encode_png(image: Any) -> bytes:
    """Encode a PIL image to PNG bytes in memory (no page/table images, just this picture crop)."""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _write_artifact_file(directory: str, name: str, data: bytes) -> None:
    """Write ``data`` to ``directory/name`` via a temp file + atomic rename.

    The rename is the fence: a crashed worker never leaves a half-written artifact that a resume could
    adopt — only a fully written file appears under its final name.
    """
    fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    os.replace(tmp_path, os.path.join(directory, name))


def extract_picture_artifact(item: Any, doc: Any, sink: ArtifactSink) -> Optional[dict[str, Any]]:
    """Render one picture item to a PNG artifact and return its manifest ref, or None.

    Returns None when the picture cannot be rendered (no image) or the rendered PNG exceeds the
    per-picture byte ceiling — either way the caller leaves the item ref-less so it maps to a #806
    unresolved placeholder rather than a resolved figure. The ref carries only metadata (root-relative
    path, image/png, sha256, byte length, pixel dimensions); the bytes stay on disk.
    """
    image = sink.read_image(item, doc)
    if image is None:
        return None
    data = _encode_png(image)
    if len(data) > sink.max_bytes:
        return None
    name = sink.next_name()
    _write_artifact_file(sink.directory, name, data)
    return {
        "path": name,
        "contentType": "image/png",
        "sha256": hashlib.sha256(data).hexdigest(),
        "byteLength": len(data),
        "width": int(image.width),
        "height": int(image.height),
    }


def map_item(
    item: Any,
    doc: Any,
    resolve: Callable[[Any, Any], Any],
    page_confidences: dict[int, float],
    inherited_page: int,
    sink: Optional[ArtifactSink] = None,
    code_cluster_index: Optional[dict[int, list[tuple[dict[str, float], str]]]] = None,
) -> dict[str, Any]:
    """Project one DoclingDocument node (and its subtree) into a contract item.

    Layout order, labels, tables, and figures are fallible evidence: the raw docling ``label`` is kept
    verbatim (never narrowed to an enum), and low-confidence/unknown items are preserved with their
    geometry and provenance — nothing is silently dropped. Children are mapped recursively in order.
    A docling ``TableItem`` is special: it carries no ``children``, so its ``data.table_cells`` grid is
    projected into ordered ``table_row`` -> cell items (see ``_table_rows``) that the canonical mapper
    turns into a PM ``table`` block. When an ``ArtifactSink`` is supplied and this item is a picture
    whose image renders, a manifest ref to the extracted PNG is attached as ``imageArtifact`` (#807).

    ``inherited_page`` is only the LAST resort: a node with no provenance of its own borrows page, box,
    and span from the content it holds first (``_resolve_geometry``), so a group reports the page its
    content is actually on rather than a page nothing on it came from (#813).

    When a ``code_cluster_index`` (``build_code_cluster_index``) is supplied and this item is a code
    listing, its flattened ``item.text`` is replaced by the reconstructed multi-line text of whichever
    indexed cluster's bbox matches this item's own resolved ``bounding_box`` (#876) — every other label,
    and a code item with no confident match, is completely unaffected.
    """
    page_number, bounding_box, char_span = _resolve_geometry(item, doc, resolve, inherited_page)
    table_rows = _table_rows(item, page_number, page_confidences)
    if table_rows is not None:
        children = table_rows
    else:
        children_refs = getattr(item, "children", None) or []
        children = [
            map_item(
                resolve(ref, doc), doc, resolve, page_confidences, page_number, sink, code_cluster_index
            )
            for ref in children_refs
        ]
    label = str(getattr(item, "label", "unknown"))
    text = str(getattr(item, "text", "") or "")
    if label == CODE_CLUSTER_LABEL and code_cluster_index is not None:
        matched = _match_code_cluster_text(bounding_box, code_cluster_index.get(page_number, []))
        if matched is not None:
            text = matched
    mapped: dict[str, Any] = {
        "label": label,
        "pageNumber": page_number,
        "boundingBox": bounding_box,
        "charSpan": char_span,
        "confidence": _confidence(item, page_confidences, page_number),
        "text": text,
        "children": children,
    }
    if sink is not None and label in PICTURE_LABELS:
        artifact = extract_picture_artifact(item, doc, sink)
        if artifact is not None:
            mapped["imageArtifact"] = artifact
    return mapped


def map_group(
    group: Any,
    doc: Any,
    resolve: Callable[[Any, Any], Any],
    page_confidences: dict[int, float],
    fallback_page: int,
    sink: Optional[ArtifactSink] = None,
    code_cluster_index: Optional[dict[int, list[tuple[dict[str, float], str]]]] = None,
) -> list[dict[str, Any]]:
    """Map a top-level group's ordered children (body or furniture) into contract items.

    ``fallback_page`` is the range's FIRST page (``build_range_payload``'s ``start_page``): the last
    resort for a top-level node whose whole subtree carries no provenance. It is deliberately NOT the
    constant 1 — a range converted from page 300 that reported page 1 would attribute its content to a
    page it cannot be on (#813).

    An ``ArtifactSink`` is threaded only for the body group (the only source of canonical figures), so a
    furniture picture is never extracted to a would-be-orphaned artifact. A ``code_cluster_index``
    (#876) is likewise meaningful only for the body group — page furniture is never a code listing.
    """
    children_refs = getattr(group, "children", None) or []
    return [
        map_item(resolve(ref, doc), doc, resolve, page_confidences, fallback_page, sink, code_cluster_index)
        for ref in children_refs
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


def read_pdf_outline(document: Any) -> list[dict[str, Any]]:
    """Read an open pypdfium2 document's bookmark tree into raw ``{title, level, pageIndex}`` records.

    The bookmark outline is the author's OWN declared hierarchy (#815) — the only depth evidence a PDF
    carries — so it is read here once and travels in the range contract; the mapper never re-opens the
    PDF. ``PdfBookmark.level`` is 0-based (its number of parents) and ``get_dest().get_index()`` is a
    0-based page index; both are projected to the contract's 1-based form by ``build_document_outline``.

    Fail-soft PER ENTRY: a bookmark whose title or destination cannot be read is dropped and the walk
    continues, because one broken bookmark must never cost the other 383. The walk is bounded by
    ``MAX_OUTLINE_ENTRIES`` and ``MAX_OUTLINE_DEPTH`` so a hostile tree cannot make it unbounded.
    """
    entries: list[dict[str, Any]] = []
    for bookmark in document.get_toc(max_depth=MAX_OUTLINE_DEPTH):
        if len(entries) >= MAX_OUTLINE_ENTRIES:
            break
        try:
            destination = bookmark.get_dest()
            page_index = None if destination is None else destination.get_index()
            entries.append(
                {
                    "title": bookmark.get_title(),
                    "level": bookmark.level,
                    "pageIndex": page_index,
                }
            )
        except Exception:  # noqa: BLE001 - one unreadable bookmark never costs the rest of the outline.
            continue
    return entries


def pdf_outline_reader(
    pdf_path: str, opener: Callable[[str], Any]
) -> Callable[[], Sequence[Mapping[str, Any]]]:  # pragma: no cover - real backend; read tested via fake.
    """A bookmark-outline reader over the same pypdfium2 backend, mirroring ``pdf_metadata_reader``.

    Only the ``opener`` call lives here; the bounded, fail-soft walk is ``read_pdf_outline``, which tests
    against a fake document so the real pypdfium2 read stays out of the coverage lane.
    """
    document = opener(pdf_path)

    def read() -> Sequence[Mapping[str, Any]]:
        return read_pdf_outline(document)

    return read


def build_document_outline(raw_entries: Any) -> list[dict[str, Any]]:
    """Project raw bookmark records into the contract's ``[{title, level, pageNumber}]`` (#815).

    Cleans like ``build_document_metadata`` does and additionally BOUNDS the result, because an outline
    comes from an untrusted file: a blank/non-string title, a non-integer level, or an entry with no
    resolvable destination page is DROPPED (an entry that cannot be located cannot resolve a heading);
    titles are truncated to ``MAX_OUTLINE_TITLE_CHARS`` and the list to ``MAX_OUTLINE_ENTRIES``. Levels
    and page numbers are converted from pypdfium2's 0-based form to the contract's 1-based form. Source
    order is preserved, so the contract carries the tree as the author declared it.
    """
    outline: list[dict[str, Any]] = []
    for entry in raw_entries:
        if len(outline) >= MAX_OUTLINE_ENTRIES:
            break
        projected = _project_outline_entry(entry)
        if projected is not None:
            outline.append(projected)
    return outline


def _project_outline_entry(entry: Any) -> Optional[dict[str, Any]]:
    """Project one raw bookmark record, or None when it is unusable (blank title / unlocatable page)."""
    if not isinstance(entry, Mapping):
        return None
    title = clean_metadata_value(entry.get("title"))
    if title is None:
        return None
    level = entry.get("level")
    page_index = entry.get("pageIndex")
    # `bool` is an `int` subclass in Python; excluding it keeps a `True` level from becoming level 2.
    if not isinstance(level, int) or isinstance(level, bool) or level < 0:
        return None
    if not isinstance(page_index, int) or isinstance(page_index, bool) or page_index < 0:
        return None
    return {
        "title": title[:MAX_OUTLINE_TITLE_CHARS],
        "level": level + 1,
        "pageNumber": page_index + 1,
    }


def read_outline_entries(
    read_outline: Optional[Callable[[], Any]]
) -> Optional[list[dict[str, Any]]]:
    """Call the outline seam fail-soft (#815): ``None`` when unwired, ``[]`` when the read failed.

    An outline is optional evidence, so a PDF with no bookmarks, a backend that raised, or a tree that
    projected to nothing all yield an EMPTY outline on the payload — never a failed conversion. The
    distinction between ``None`` (no seam wired at all: an older/back-compat run) and ``[]`` (a seam ran
    and found nothing) is what keeps the payload field truly optional.
    """
    if read_outline is None:
        return None
    try:
        raw = read_outline()
    except Exception:  # noqa: BLE001 - an outline is optional evidence; never fail a conversion for it.
        return []
    return build_document_outline(raw)


def build_range_payload(
    doc: Any,
    start_page: int,
    end_page: int,
    native_text: Callable[[int], bool],
    metadata: Optional[Mapping[str, Any]] = None,
    sink: Optional[ArtifactSink] = None,
    outline: Optional[Sequence[Mapping[str, Any]]] = None,
    native_text_length: Optional[Callable[[int], int]] = None,
    code_cluster_index: Optional[dict[int, list[tuple[dict[str, float], str]]]] = None,
) -> dict[str, Any]:
    """Assemble one range payload from a converted DoclingDocument.

    Rejects an unsupported schema version up front (``UnsupportedSchema``) so an incompatible converter
    is a named failure, not a silent misread. Preserves the ordered body/furniture trees and reports
    native-text availability for every page in [start_page, end_page]. When the caller supplies the raw
    PDF info dictionary, attaches its cleaned ``metadata`` (#702's title/author fallback source). When an
    ``ArtifactSink`` is supplied, each renderable body picture carries an ``imageArtifact`` ref (#807).
    ``start_page`` is also the last-resort page for a provenance-less item, so a range never reports a
    page outside its own window (#813). When the caller supplies the document's already-projected
    bookmark records, attaches them as ``outline`` (#815's declared heading hierarchy) — document-level
    evidence repeated on every range, exactly like ``metadata``, so the Node side takes the first
    non-empty one. When the caller supplies a ``native_text_length`` seam, each page also carries the
    PDF's own whitespace-stripped character count as ``nativeTextLength`` (#817's usability rubric
    measures the mapped body against this independent, worker-side count); without one it is omitted,
    exactly like ``metadata``/``outline``, so an older run is never mistaken for a measured-zero page.
    When the caller supplies a ``code_cluster_index`` (``build_code_cluster_index``), each code listing
    in the BODY is reconstructed to its original multi-line, indented form (#876); furniture never
    carries code, so it is mapped without one regardless.
    """
    version = str(getattr(doc, "version", ""))
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise UnsupportedSchema(version)

    page_confidences = page_confidence_map(doc)
    pages = []
    for page in range(start_page, end_page + 1):
        page_payload: dict[str, Any] = {"pageNumber": page, "hasNativeText": bool(native_text(page))}
        if native_text_length is not None:
            page_payload["nativeTextLength"] = int(native_text_length(page))
        pages.append(page_payload)
    payload: dict[str, Any] = {
        "schemaVersion": RANGE_SCHEMA_VERSION,
        "doclingSchema": {"name": DOCLING_SCHEMA_NAME, "version": version},
        "pages": pages,
        "body": map_group(
            getattr(doc, "body", None),
            doc,
            _resolve_ref,
            page_confidences,
            start_page,
            sink,
            code_cluster_index,
        ),
        "furniture": map_group(
            getattr(doc, "furniture", None), doc, _resolve_ref, page_confidences, start_page
        ),
    }
    if metadata is not None:
        payload["metadata"] = build_document_metadata(metadata)
    if outline is not None:
        payload["outline"] = list(outline)
    return payload


def load_conversion_status() -> Any:
    """Import docling's ``ConversionStatus`` enum lazily, mirroring ``build_converter``'s import style.

    Lazy for the same reason the converter's imports are: a host without the doc-AI lane must surface a
    plain ``ImportError`` (classified as ``EXIT_MISSING_DEPENDENCY`` in ``run_range``) rather than failing
    at module load and turning every mode — including ``--check-memory-ceiling`` — into a crash.
    """
    from docling.datamodel.base_models import ConversionStatus

    return ConversionStatus


def _failed_page_numbers(errors: Sequence[Any]) -> list[int]:
    """The distinct, ascending 1-based page numbers Docling reported an error for."""
    pages = set()
    for error in errors:
        page_no = getattr(error, "page_no", None)
        if isinstance(page_no, int) and not isinstance(page_no, bool):
            pages.add(page_no)
    return sorted(pages)


def _conversion_error_reason(status: Any, errors: Sequence[Any]) -> str:
    """Docling's OWN account of why the range degraded: its distinct error messages, bounded.

    Never a message this worker invented. An operator reading the attempt failure needs to tell an
    out-of-memory page (``std::bad_alloc``) apart from a malformed-glyph page, so the converter's text is
    quoted verbatim — capped at ``MAX_REPORTED_CONVERSION_ERRORS`` distinct messages so one repeated
    failure cannot flood stderr or the stored failure.
    """
    messages: list[str] = []
    for error in errors:
        message = str(getattr(error, "error_message", "") or "").strip()
        if message != "" and message not in messages:
            messages.append(message)
    if len(messages) == 0:
        return f"{status} reported with no error detail"
    quoted = "; ".join(messages[:MAX_REPORTED_CONVERSION_ERRORS])
    remaining = len(messages) - MAX_REPORTED_CONVERSION_ERRORS
    return quoted if remaining <= 0 else f"{quoted}; and {remaining} more"


def ensure_conversion_complete(result: Any) -> None:
    """Refuse a converter result that is anything other than an unqualified ``SUCCESS`` (#832).

    This is the trust boundary for one range: it runs BEFORE any payload is built, so a degraded document
    can never be mistaken for a good range.

    FAIL CLOSED. A result that reports no ``status`` at all is refused too, not accepted. ``PRODUCT.md``
    holds that a converter result is untrusted evidence, and a result that cannot report its own status is
    the purest case of that: a conversion whose completeness cannot be checked is not a complete
    conversion. It is the FIRST of two completeness guards — ``ensure_pages_processed`` then checks the
    converter's per-page processing record against the requested window (#840), so the rule no longer
    rests on the converter's report about itself alone. Judging completeness from what a page PRODUCED
    stays out of both (``docs/DECISIONS.md`` D8). The converter version is pinned, so this is
    deterministic; a future upgrade that changes the reporting contract fails loudly here instead of
    silently reopening #832.
    """
    status = getattr(result, "status", None)
    if status is not None and status == load_conversion_status().SUCCESS:
        return
    if status is None:
        raise ConversionIncomplete(
            "unreported",
            [],
            "the converter reported no conversion status, so completeness cannot be verified",
        )
    errors = list(getattr(result, "errors", None) or [])
    raise ConversionIncomplete(
        str(status), _failed_page_numbers(errors), _conversion_error_reason(status, errors)
    )


def _evidence_page_number(page: Any) -> Optional[int]:
    """The 1-based page number one ``ConversionResult.pages`` entry proves was processed, or None.

    ``page_no`` is the whole signal (#840). A missing, null, boolean (``bool`` is an ``int`` in Python)
    or non-positive value is not a page number, so such an entry proves nothing and is not counted as
    evidence — the same shape rule ``_failed_page_numbers`` applies to Docling's error records.
    """
    page_no = getattr(page, "page_no", None)
    if isinstance(page_no, bool) or not isinstance(page_no, int) or page_no < 1:
        return None
    return page_no


def processed_page_numbers(result: Any) -> set[int]:
    """The pages Docling's OWN per-page record says it processed: the ``page_no``s on ``result.pages``.

    ``ConversionResult.pages`` holds one entry per page the converter actually processed, so it records
    what the converter DID rather than what it emitted. It is NOT independent of ``status``/``errors``:
    in pinned docling (2.114.0) the status is derived from this very list — each failed page is dropped
    from it and appended to ``errors``, success is ``len(pages) == total_expected``, and a non-empty
    ``errors`` downgrades ``SUCCESS`` — so today ``status == SUCCESS`` already implies the list is as
    long as the converter EXPECTED. Reading the list directly buys two things the status cannot give:
    ``ensure_pages_processed`` compares it with the window this range REQUESTED, which the status never
    sees (docling clamps an over-long window and still reports an unqualified success), and it pins the
    page-count invariant for a converter version whose status stops standing for one.

    Measured on the real 462-page book with the pinned converter: a healthy 10-page range produced ten
    entries, ``page_no`` 21..30; the reproduced #843 degradation produced 6 entries for 50 requested
    pages, and the 44 absent pages matched Docling's own error records element for element. That match
    shows the two channels AGREE — as the shared derivation above says they must — which is what makes
    absence here a faithful record of loss. A lost page is ABSENT, never present-and-empty.

    Presence is the evidence, deliberately NOT the state hanging off an entry. Docling RELEASES per-page
    state after assembly: ``parsed_page`` is ``None`` on every perfectly converted page, so a check
    written against released state would refuse every range, healthy books included. A result carrying
    no per-page record at all yields the empty set, which refuses the whole range — fail closed.
    """
    entries = getattr(result, "pages", None)
    numbers: set[int] = set()
    for page in entries or ():
        number = _evidence_page_number(page)
        if number is not None:
            numbers.add(number)
    return numbers


def ensure_pages_processed(result: Any, start_page: int, end_page: int) -> None:
    """Refuse the range unless the converter's per-page record covers EVERY requested page (#840).

    The backstop behind ``ensure_conversion_complete``, and the one check that sees the window the range
    ASKED for. The status gate (#832) closed the reproduced hole — a ``PARTIAL_SUCCESS`` fragment
    published as a whole book — but it can only speak for the pages the converter decided to attempt: in
    pinned docling the status is derived from this very record (see ``processed_page_numbers``), so for
    in-document page loss the two fire together. They part where the converter narrows the window itself
    — asked for pages 461-470 of the real 462-page book it clamps to 461-462 and reports an unqualified
    ``SUCCESS`` with zero errors, which this refuses — and they would part again for a converter version
    whose status stops standing for a page count.

    FAILS CLOSED in the same shape as the status gate: a missing page, an unusable ``page_no``, or a
    result with no per-page record at all is evidence NOT of processing, and no payload is built. It is
    the ABSENCE of a requested page number that refuses — never a count of what a page produced, which
    was measured to be zero for pages that converted perfectly (``docs/DECISIONS.md`` D8), and never a
    proportional tolerance, which would be a weaker rule with an unprincipled threshold.
    """
    processed = processed_page_numbers(result)
    missing = [page for page in range(start_page, end_page + 1) if page not in processed]
    if len(missing) == 0:
        return
    requested = end_page - start_page + 1
    status = getattr(result, "status", None)
    raise ConversionIncomplete(
        "unreported" if status is None else str(status),
        missing,
        f"the converter's per-page record covers {requested - len(missing)} of {requested} requested "
        f"page(s): {len(missing)} page(s) carry no processing evidence, so they were never converted",
    )


def convert_range(
    pdf_path: str,
    start_page: int,
    end_page: int,
    converter_factory: Callable[[], Any],
    native_text: Callable[[int], bool],
    read_metadata: Optional[Callable[[], Mapping[str, Any]]] = None,
    sink: Optional[ArtifactSink] = None,
    read_outline: Optional[Callable[[], Any]] = None,
    native_text_length: Optional[Callable[[int], int]] = None,
) -> dict[str, Any]:
    """Convert one bounded page range to a range payload using a converter from ``converter_factory``.

    Docling's ``convert`` receives an explicit ``page_range`` so only the requested pages are decoded.
    When a ``read_metadata`` seam is supplied, its raw PDF info dictionary is cleaned onto the payload.
    When an ``ArtifactSink`` is supplied, renderable body pictures are extracted to PNG artifacts (#807).
    When a ``read_outline`` seam is supplied, the PDF's bookmark tree is projected onto the payload as
    ``outline`` (#815), fail-soft: a bookmark-less or unreadable outline is an empty list, never an error.
    When a ``native_text_length`` seam is supplied, each page's own whitespace-stripped character count
    is attached as ``nativeTextLength`` (#817), the worker-side half of the usability rubric's coverage
    comparison.

    The converter's REPORTED STATUS is checked before anything is read off the result (#832): docling
    returns a truncated document rather than raising when individual pages fail, so a payload is built
    only from a run it called an unqualified success. Its PER-PAGE PROCESSING RECORD is then checked
    against the requested window (#840), so a converter that claims success while silently dropping
    pages is refused too — the payload's per-page records are only ever emitted for a window every page
    of which the converter's own record proves it processed.

    Docling's OWN assembly step flattens every code listing to one whitespace-joined line before it ever
    reaches ``result.document`` (#876) — the per-line text with its original indentation survives only
    on ``result.pages[*].predictions.layout.clusters``, which ``_release_page_resources`` never clears.
    ``build_code_cluster_index`` captures that evidence off the full ``result`` (never exposed to
    ``build_range_payload``) so each mapped code item can recover its original multi-line form.
    """
    converter = converter_factory()
    result = converter.convert(pdf_path, page_range=(start_page, end_page))
    ensure_conversion_complete(result)
    ensure_pages_processed(result, start_page, end_page)
    metadata = read_metadata() if read_metadata is not None else None
    outline = read_outline_entries(read_outline)
    code_cluster_index = build_code_cluster_index(result)
    return build_range_payload(
        result.document,
        start_page,
        end_page,
        native_text,
        metadata,
        sink,
        outline,
        native_text_length,
        code_cluster_index,
    )


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


def _stripped_text_length(text: str) -> int:
    """Whitespace-stripped character count: every whitespace RUN removed, never merely collapsed.

    Pure and backend-free so #817's "coverage ignores formatting whitespace" rule is unit-tested
    directly. Mirrors the mapper's own character count on the mapped side of the same comparison
    (``strippedTextLength`` in ``pdfCanonicalMapping.ts``), so a page's native/mapped coverage ratio is
    never skewed by one side collapsing whitespace differently than the other.
    """
    return len("".join(text.split()))


def native_text_length_prober(pdf_path: str, opener: Callable[[str], Any]) -> Callable[[int], int]:
    """A per-page native TEXT LENGTH: the page's own text layer, whitespace-stripped (#817).

    Uses the same backend as ``native_text_prober``/the page count. This is the worker-side half of
    #817's usability rubric: an independent measurement of how much text the PDF's OWN text layer holds
    for a page, taken before mapping, so the rubric can compare it against how much of that text made it
    into the mapped document without either side's own losses hiding the other's.
    """
    document = opener(pdf_path)  # pragma: no cover - real backend; logic below tested via fake.

    def text_length(page_number: int) -> int:  # pragma: no cover - real backend page access.
        page = document[page_number - 1]
        textpage = page.get_textpage()
        return _stripped_text_length(textpage.get_text_range())

    return text_length


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
    artifact_dir: Optional[str] = None,
    image_reader: Callable[[Any, Any], Any] = _picture_image_reader,
    outline_reader_factory: Optional[Callable[[str], Callable[[], Any]]] = None,
    length_prober_factory: Optional[Callable[[str], Callable[[int], int]]] = None,
) -> int:
    """``--range`` mode: emit one validated range payload, classifying each failure distinctly.

    When a ``metadata_reader_factory`` is wired, the payload carries the source PDF's cleaned document
    metadata (#702's title/author fallback); without one it is simply omitted (an older/metadata-less run).
    When an ``artifact_dir`` is supplied, renderable body pictures are extracted into it as PNG artifacts
    and referenced from the payload (#807); without one (a probe/back-compat run) no picture is extracted.
    When an ``outline_reader_factory`` is wired, the payload carries the PDF's bookmark outline (#815);
    without one it is omitted, and a PDF that simply has no bookmarks carries an empty one.
    When a ``length_prober_factory`` is wired, every page also carries its own whitespace-stripped native
    text length (#817); without one it is omitted, exactly like metadata/outline.
    """
    try:
        native_text = prober_factory(pdf_path)
        read_metadata = (
            metadata_reader_factory(pdf_path) if metadata_reader_factory is not None else None
        )
        read_outline = (
            outline_reader_factory(pdf_path) if outline_reader_factory is not None else None
        )
        native_text_length = (
            length_prober_factory(pdf_path) if length_prober_factory is not None else None
        )
        sink = ArtifactSink(artifact_dir, image_reader) if artifact_dir is not None else None
        payload = convert_range(
            pdf_path,
            start_page,
            end_page,
            converter_factory,
            native_text,
            read_metadata,
            sink,
            read_outline,
            native_text_length,
        )
    except PasswordRequired:
        _write(stderr, "pdf is encrypted; a password is required to open it.\n")
        return EXIT_PASSWORD_REQUIRED
    except UnsupportedSchema as error:
        _write(stderr, f"unsupported DoclingDocument schema version: {error.version}\n")
        return EXIT_UNSUPPORTED_SCHEMA
    except ConversionIncomplete as error:
        # A degraded conversion is reported with the pages it lost, not summarized as "failed": the range
        # is retried or the import is abandoned by a human who can see WHICH pages docling dropped and
        # WHY. The page list is bounded so a range that failed wholesale cannot flood the parent's pipe.
        shown = error.failed_pages[:MAX_REPORTED_FAILED_PAGES]
        pages = ", ".join(str(page) for page in shown) if len(shown) > 0 else "not reported"
        if len(error.failed_pages) > len(shown):
            pages = f"{pages}, and {len(error.failed_pages) - len(shown)} more"
        _write(
            stderr,
            f"pdf conversion did not complete for {pdf_path} pages {start_page}-{end_page}: "
            f"docling reported {error.status} for {len(error.failed_pages)} failed page(s) "
            f"[{pages}]: {error.reason}\n",
        )
        return EXIT_CONVERSION_INCOMPLETE
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
    outline_reader_factory: Optional[Callable[[str], Callable[[], Any]]] = None,
    length_prober_factory: Optional[Callable[[str], Callable[[int], int]]] = None,
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
    if outline_reader_factory is None:
        outline_reader_factory = lambda path: pdf_outline_reader(path, opener)
    if length_prober_factory is None:
        length_prober_factory = lambda path: native_text_length_prober(path, opener)

    # Every return below — including the early readiness-probe, unenforceable-ceiling and usage returns —
    # leaves through this `finally`, so the boundary's teardown-time enforcement is stood down on EVERY
    # orderly exit path and the code the worker decided is the code the OS reports (#843). An exception on
    # its way to `_entrypoint`'s ImportError/MemoryError handlers passes through here too, so those codes
    # survive as well. Peak memory is read before this point, and `release` keeps the handle open anyway.
    try:
        # The readiness probe exercises the real controller itself, so it precedes (and does not
        # double-apply) the startup ceiling.
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
            elif len(argv) in (4, 5) and argv[0] == "--range":
                start_page = _parse_positive_int(argv[2])
                end_page = _parse_positive_int(argv[3])
                if end_page < start_page:
                    raise ValueError("end page must be >= start page")
                artifact_dir = argv[4] if len(argv) == 5 else None
                code = run_range(
                    argv[1],
                    start_page,
                    end_page,
                    converter_factory,
                    prober_factory,
                    stdout,
                    stderr,
                    metadata_reader_factory,
                    artifact_dir,
                    outline_reader_factory=outline_reader_factory,
                    length_prober_factory=length_prober_factory,
                )
            else:
                _write(
                    stderr,
                    "usage: pdf_to_docling.py --probe <file.pdf> | "
                    "--range <file.pdf> <start> <end> [artifact-dir] | --check-memory-ceiling\n",
                )
                return EXIT_USAGE
        except ValueError as error:
            _write(stderr, f"usage error: {error}\n")
            return EXIT_USAGE

        # Emit the bounded peak-memory sidecar only for a successful conversion, so a failure's partial
        # peak is never mistaken for a completed run's metric.
        if code == EXIT_OK:
            metrics_writer(os.environ.get(METRICS_PATH_ENV), boundary)
        return code
    finally:
        release_memory_boundary(boundary)


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
