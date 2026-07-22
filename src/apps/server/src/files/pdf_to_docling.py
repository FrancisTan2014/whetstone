#!/usr/bin/env python3
"""Bounded structured PDF worker (#701): born-digital PDF -> validated DoclingDocument JSON.

The Node ``pdfStructuredAdapter`` spawns this one-shot worker, one child per operation, under a
per-range time ceiling (the parent kills on timeout) and a self-applied memory ceiling. It NEVER
emits Markdown and never defines a content model: it projects docling-core's DoclingDocument into the
adapter's ``whetstone-pdf-structured-range/1`` JSON contract (schema + geometry + provenance +
per-page native-text), and the Node side validates and concatenates ranges.

Two modes:

- ``--probe <file.pdf>``  -> ``{"pageCount": N}`` on stdout. Encrypted input exits
  ``EXIT_PASSWORD_REQUIRED``; a broken file exits ``EXIT_CONVERSION_FAILED``.
- ``--range <file.pdf> <start> <end>`` -> one range payload JSON on stdout.

Reliability contract (mirrors the #403 markdown worker, kept in LOCKSTEP with pdfStructuredErrors.ts):

- Every Docling/OCR engine is DISABLED here (``do_ocr=False``): this is the born-digital slice, so a
  page with no native text is reported ``hasNativeText: false`` for #702/#704 to act on, never OCR'd.
- Output is UTF-8 regardless of host locale, so CJK/Greek text never raises ``UnicodeEncodeError`` on
  a cp1252 Windows console.
- Failures self-classify via exit code (missing dependency, conversion failed, password required,
  unsupported schema, memory, memory-ceiling-unsupported) — never a bare traceback as the only signal.
- The per-child memory ceiling is ENFORCED, not best-effort: if a ceiling is requested but the
  platform cannot apply one (POSIX ``resource`` is unavailable, e.g. Windows) the worker refuses with
  ``EXIT_MEMORY_CEILING_UNSUPPORTED`` instead of running unbounded. The Node runner additionally
  fences the whole real adapter off on such a platform, so this is defense in depth.

Docling objects and real I/O are built behind ``build_converter`` / ``open_backend`` seams (mirroring
the whisper wrapper's ``model_loader``) so the mapping, payload, dispatch, and bounds logic is
unit-tested against fakes with no real models or network.

Permissive deps only: Docling + docling-core (MIT). OCR is disabled, not delegated.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Callable, Mapping, Optional, Sequence

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
    """Raised when a memory ceiling is requested but the platform cannot enforce one (e.g. Windows).

    The bounded adapter (#701) promises a memory-bounded conversion, so an unenforceable ceiling is a
    hard refusal — never a silent unbounded run.
    """

    def __init__(self, mib: int) -> None:
        super().__init__(
            f"a {mib} MiB per-child memory ceiling was requested but cannot be enforced on this "
            "platform (POSIX `resource` is unavailable)"
        )
        self.mib = mib


def apply_memory_limit(mib: Optional[str], resource_module: Any) -> None:
    """Self-apply an address-space ceiling so an oversized conversion is killed, not left to swap.

    The ceiling is ENFORCED, not best-effort. ``resource`` is POSIX-only; when a positive ceiling is
    requested (a numeric, positive ``mib``) but the platform cannot apply one (``resource_module is
    None``, e.g. Windows), this raises ``MemoryCeilingUnsupported`` rather than silently running
    unbounded — the #701 memory-bounded invariant must hold or the conversion must refuse. A
    non-numeric/absent/non-positive env requests no ceiling and is a no-op. Injected so the tests drive
    both branches without a real rlimit.
    """
    if mib is None:
        return
    try:
        limit_mib = int(mib)
    except (TypeError, ValueError):
        return
    if limit_mib <= 0:
        return
    if resource_module is None:
        raise MemoryCeilingUnsupported(limit_mib)
    limit_bytes = limit_mib * 1024 * 1024
    resource_module.setrlimit(
        resource_module.RLIMIT_AS, (limit_bytes, limit_bytes)
    )


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


def _bounding_box(prov: Any) -> dict[str, float]:
    """Project a docling ProvenanceItem bbox to the contract's left/top/right/bottom floats."""
    if prov is None:
        return {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
    bbox = prov.bbox
    return {
        "left": float(bbox.l),
        "top": float(bbox.t),
        "right": float(bbox.r),
        "bottom": float(bbox.b),
    }


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
    """
    prov = _prov(item)
    page_number = _page_number(prov, inherited_page)
    children_refs = getattr(item, "children", None) or []
    return {
        "label": str(getattr(item, "label", "unknown")),
        "pageNumber": page_number,
        "boundingBox": _bounding_box(prov),
        "charSpan": _char_span(prov),
        "confidence": _confidence(item, page_confidences, page_number),
        "text": str(getattr(item, "text", "") or ""),
        "children": [
            map_item(resolve(ref, doc), doc, resolve, page_confidences, page_number)
            for ref in children_refs
        ],
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
    stdout: Any,
    stderr: Any,
) -> int:
    """``--probe`` mode: emit the page count, classifying encryption and corruption distinctly."""
    try:
        page_count = count_pages(pdf_path, opener)
    except PasswordRequired:
        _write(stderr, "pdf is encrypted; a password is required to open it.\n")
        return EXIT_PASSWORD_REQUIRED
    except ImportError as error:
        _write(
            stderr,
            f"pdf tooling is not installed ({error}); run `pnpm setup:pdf` to enable PDF ingestion.\n",
        )
        return EXIT_MISSING_DEPENDENCY
    except ConversionFailed as error:
        _write(stderr, f"pdf probe failed for {pdf_path}: {error}\n")
        return EXIT_CONVERSION_FAILED
    _write(stdout, json.dumps({"pageCount": page_count}))
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


def main(
    argv: Optional[Sequence[str]] = None,
    converter_factory: Callable[[], Any] = build_converter,
    opener: Callable[[str], Any] = open_backend,
    prober_factory: Optional[Callable[[str], Callable[[int], bool]]] = None,
    resource_module: Any = "__default__",
    stdout: Any = None,
    stderr: Any = None,
    metadata_reader_factory: Optional[
        Callable[[str], Callable[[], Mapping[str, Any]]]
    ] = None,
) -> int:
    """Parse args, apply the memory ceiling, and dispatch to the requested mode."""
    import os

    argv = sys.argv[1:] if argv is None else list(argv)
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    if resource_module == "__default__":
        resource_module = _load_resource_module()
    if prober_factory is None:
        prober_factory = lambda path: native_text_prober(path, opener)
    if metadata_reader_factory is None:
        metadata_reader_factory = lambda path: pdf_metadata_reader(path, opener)

    try:
        apply_memory_limit(os.environ.get(MEMORY_LIMIT_ENV), resource_module)
    except MemoryCeilingUnsupported as error:
        _write(
            stderr,
            f"{error}; run the structured PDF adapter on a POSIX platform (Linux/macOS) where a "
            "per-child memory ceiling can be enforced.\n",
        )
        return EXIT_MEMORY_CEILING_UNSUPPORTED

    try:
        if len(argv) == 2 and argv[0] == "--probe":
            return run_probe(argv[1], opener, stdout, stderr)
        if len(argv) == 4 and argv[0] == "--range":
            start_page = _parse_positive_int(argv[2])
            end_page = _parse_positive_int(argv[3])
            if end_page < start_page:
                raise ValueError("end page must be >= start page")
            return run_range(
                argv[1],
                start_page,
                end_page,
                converter_factory,
                prober_factory,
                stdout,
                stderr,
                metadata_reader_factory,
            )
    except ValueError as error:
        _write(stderr, f"usage error: {error}\n")
        return EXIT_USAGE

    _write(
        stderr,
        "usage: pdf_to_docling.py --probe <file.pdf> | --range <file.pdf> <start> <end>\n",
    )
    return EXIT_USAGE


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
