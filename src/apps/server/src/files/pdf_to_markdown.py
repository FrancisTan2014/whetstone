#!/usr/bin/env python3
"""One-shot PDF -> Markdown worker (#15, hardened in #403).

Converts a born-digital PDF to clean Markdown using Docling (MIT, permissive) and writes it to
stdout as UTF-8. The Node server spawns this behind the PdfToMarkdown seam; with no Python/Docling
present the server uses a deterministic fake instead, so the build/test gate never needs this lane.

Reliability contract (#403):
- Docling's internal OCR is **disabled** here (``do_ocr=False``). Scanned OCR is the separate
  OCRmyPDF pre-pass's job (#261), and a fresh ``pip install docling`` ships a rapidocr/PP-OCR
  config the default converter cannot initialize — building the converter through Docling's
  designed pipeline options with OCR off keeps that fragile engine off the born-digital path.
- Output is written as **UTF-8** regardless of the host locale, so CJK/Greek text does not raise
  ``UnicodeEncodeError`` on a cp1252 Windows console.
- Failures are **self-guiding**: a clear message on stderr plus a non-zero exit whose code
  distinguishes a missing dependency (ImportError -> 3) from a conversion failure (-> 4), never a
  bare traceback as the only signal.

The Docling converter is built behind ``build_converter`` (mirroring the whisper wrapper's
``model_loader`` seam) so the arg-parsing, encoding, and failure logic is unit-tested against a
fake converter with no real models or network.

Usage: python pdf_to_markdown.py <file.pdf>
Permissive deps only: Docling (MIT). No AGPL/GPL converters; OCR stays the pre-pass's job.
"""
from __future__ import annotations

import sys
from typing import Any, Callable, Optional, Sequence

EXIT_USAGE = 2
EXIT_MISSING_DEPENDENCY = 3
EXIT_CONVERSION_FAILED = 4


def build_converter() -> Any:
    """Build a Docling converter with internal OCR disabled via its pipeline options.

    Imported lazily so a missing doc-AI lane surfaces as ImportError (handled in ``main``) rather
    than a module-load crash. OCR is off because scanned OCR is the OCRmyPDF pre-pass's job (#261)
    and Docling's default OCR engine dependency is fragile on a fresh install (#403).
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False

    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )


def convert_pdf(pdf_path: str, converter_factory: Callable[[], Any]) -> str:
    """Convert a PDF to Markdown using a converter from ``converter_factory``."""
    converter = converter_factory()
    result = converter.convert(pdf_path)
    return result.document.export_to_markdown()


def _write(stream: Any, text: str) -> None:
    """Write ``text`` as UTF-8, bypassing the host locale codec when the stream exposes a buffer.

    The real process's ``sys.stdout``/``sys.stderr`` have a binary ``.buffer``; writing encoded
    bytes there avoids the cp1252 ``UnicodeEncodeError`` that ``stream.write(text)`` would raise on
    non-Latin output. Test streams without a ``.buffer`` fall back to a plain text write.
    """
    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        buffer.write(text.encode("utf-8"))
        buffer.flush()
    else:
        stream.write(text)


def main(
    argv: Optional[Sequence[str]] = None,
    converter_factory: Callable[[], Any] = build_converter,
    stdout: Any = None,
    stderr: Any = None,
) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr

    if len(argv) != 1:
        _write(stderr, "usage: pdf_to_markdown.py <file.pdf>\n")
        return EXIT_USAGE

    pdf_path = argv[0]

    try:
        markdown = convert_pdf(pdf_path, converter_factory)
    except ImportError:
        _write(stderr, "docling is not installed; install the doc-AI lane to ingest PDFs.\n")
        return EXIT_MISSING_DEPENDENCY
    except Exception as error:  # noqa: BLE001 - classify any conversion failure, never crash raw.
        _write(stderr, f"pdf conversion failed for {pdf_path}: {error}\n")
        return EXIT_CONVERSION_FAILED

    _write(stdout, markdown)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    sys.exit(main())
