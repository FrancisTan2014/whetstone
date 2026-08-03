"""Measure WHERE text is lost in the PDF ingestion pipeline.

Stages measured for one page range:
  native   - the PDF's own text layer (ground truth floor)
  docling  - all text in the DoclingDocument tree (recursive)
  toplevel - text reachable from body children WITHOUT recursion (what pdfCanonicalMapping.walkBody keeps)
  html     - text in docling's export_to_html output
"""

from __future__ import annotations

import json
import re
import sys
import time

import pypdfium2 as pdfium

PDF = sys.argv[1]
START = int(sys.argv[2])
END = int(sys.argv[3])


def norm(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def native_text(path: str, start: int, end: int) -> str:
    doc = pdfium.PdfDocument(path)
    out = []
    for index in range(start - 1, min(end, len(doc))):
        textpage = doc[index].get_textpage()
        out.append(textpage.get_text_range())
    return "\n".join(out)


def walk_all(item, doc, seen):
    """All text in the subtree, mirroring the worker's recursive map_item."""
    total = []
    ref_id = id(item)
    if ref_id in seen:
        return total
    seen.add(ref_id)
    total.append(str(getattr(item, "text", "") or ""))
    for ref in getattr(item, "children", None) or []:
        resolver = getattr(ref, "resolve", None)
        child = resolver(doc) if callable(resolver) else ref
        total.extend(walk_all(child, doc, seen))
    return total


def main() -> None:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = False
    options.generate_picture_images = False
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )

    started = time.time()
    result = converter.convert(PDF, page_range=(START, END))
    elapsed = time.time() - started
    doc = result.document

    body = getattr(doc, "body", None)
    refs = getattr(body, "children", None) or []

    toplevel_chunks = []
    all_chunks = []
    labels: dict[str, int] = {}
    seen: set[int] = set()
    for ref in refs:
        resolver = getattr(ref, "resolve", None)
        item = resolver(doc) if callable(resolver) else ref
        toplevel_chunks.append(str(getattr(item, "text", "") or ""))
        all_chunks.extend(walk_all(item, doc, seen))
        label = str(getattr(item, "label", "unknown"))
        labels[label] = labels.get(label, 0) + 1

    html = doc.export_to_html()
    html_text = re.sub(r"<[^>]+>", " ", html)

    native = native_text(PDF, START, END)
    base = len(norm(native)) or 1

    report = {
        "pdf": PDF,
        "pages": [START, END],
        "seconds": round(elapsed, 1),
        "nativeChars": base,
        "coverage": {
            "doclingTree": round(len(norm("".join(all_chunks))) / base * 100, 1),
            "topLevelOnly": round(len(norm("".join(toplevel_chunks))) / base * 100, 1),
            "doclingHtml": round(len(norm(html_text)) / base * 100, 1),
        },
        "topLevelItems": len(refs),
        "labels": dict(sorted(labels.items(), key=lambda kv: -kv[1])),
        "htmlTags": {
            tag: len(re.findall(rf"<{tag}[ >]", html))
            for tag in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "table", "pre", "code", "img", "ul", "ol", "li")
        },
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
