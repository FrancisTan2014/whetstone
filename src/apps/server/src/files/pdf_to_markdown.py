#!/usr/bin/env python3
"""One-shot PDF -> Markdown worker (#15).

Converts a born-digital PDF to clean Markdown using Docling (MIT, permissive) and prints it to
stdout. The Node server spawns this behind the PdfToMarkdown seam; with no Python/Docling present
the server uses a deterministic fake instead, so the build/test gate never needs this lane.

Usage: python pdf_to_markdown.py <file.pdf>
Permissive deps only: Docling (MIT). No AGPL/GPL converters. Scanned/OCR is a follow-up.
"""
import sys


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: pdf_to_markdown.py <file.pdf>\n")
        return 2

    pdf_path = sys.argv[1]

    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        sys.stderr.write("docling is not installed; install the doc-AI lane to ingest PDFs.\n")
        return 3

    converter = DocumentConverter()
    result = converter.convert(pdf_path)
    sys.stdout.write(result.document.export_to_markdown())
    return 0


if __name__ == "__main__":
    sys.exit(main())
