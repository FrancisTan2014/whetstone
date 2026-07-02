"""Unit tests for the PDF -> Markdown worker (#403).

No real Docling models or network: ``build_converter``'s docling imports are mocked via
``sys.modules``, and the conversion/encoding/failure paths run against a fake converter injected
through ``converter_factory``. Mirrors ``scripts/setup/whisper-wrapper/tests``.

Run with ``python -m unittest`` from this folder.
"""
import io
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pdf_to_markdown import (  # noqa: E402  (path set above)
    EXIT_CONVERSION_FAILED,
    EXIT_MISSING_DEPENDENCY,
    EXIT_USAGE,
    build_converter,
    main,
)


class FakeDocument:
    def __init__(self, markdown):
        self._markdown = markdown

    def export_to_markdown(self):
        return self._markdown


class FakeResult:
    def __init__(self, markdown):
        self.document = FakeDocument(markdown)


class FakeConverter:
    def __init__(self, markdown):
        self._markdown = markdown
        self.converted = []

    def convert(self, pdf_path):
        self.converted.append(pdf_path)
        return FakeResult(self._markdown)


def fake_factory(markdown):
    return lambda: FakeConverter(markdown)


class BuildConverterTests(unittest.TestCase):
    def test_builds_the_docling_converter_with_ocr_disabled(self):
        # Mock the docling import surface so no real models load. Docling defaults do_ocr to True;
        # the worker must turn it off so scanned OCR stays the OCRmyPDF pre-pass's job (#261, #403).
        captured = {}

        class FakePipelineOptions:
            def __init__(self):
                self.do_ocr = True

        class FakePdfFormatOption:
            def __init__(self, pipeline_options):
                self.pipeline_options = pipeline_options

        class FakeDocumentConverter:
            def __init__(self, format_options):
                captured["format_options"] = format_options

        docling = types.ModuleType("docling")
        datamodel = types.ModuleType("docling.datamodel")
        base_models = types.ModuleType("docling.datamodel.base_models")
        pipeline_options = types.ModuleType("docling.datamodel.pipeline_options")
        document_converter = types.ModuleType("docling.document_converter")

        base_models.InputFormat = types.SimpleNamespace(PDF="pdf")
        pipeline_options.PdfPipelineOptions = FakePipelineOptions
        document_converter.DocumentConverter = FakeDocumentConverter
        document_converter.PdfFormatOption = FakePdfFormatOption
        docling.datamodel = datamodel
        datamodel.base_models = base_models
        datamodel.pipeline_options = pipeline_options
        docling.document_converter = document_converter

        modules = {
            "docling": docling,
            "docling.datamodel": datamodel,
            "docling.datamodel.base_models": base_models,
            "docling.datamodel.pipeline_options": pipeline_options,
            "docling.document_converter": document_converter,
        }
        saved = {name: sys.modules.get(name) for name in modules}
        sys.modules.update(modules)
        try:
            build_converter()
        finally:
            for name, prior in saved.items():
                if prior is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = prior

        options = captured["format_options"]["pdf"].pipeline_options
        self.assertFalse(options.do_ocr)


class MainTests(unittest.TestCase):
    def test_converts_and_writes_markdown_to_stdout(self):
        converter = FakeConverter("# Title\n\nBody.")
        stdout = io.StringIO()
        code = main(
            ["/tmp/a.pdf"],
            converter_factory=lambda: converter,
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, 0)
        self.assertEqual(converter.converted, ["/tmp/a.pdf"])
        self.assertEqual(stdout.getvalue(), "# Title\n\nBody.")

    def test_writes_cjk_markdown_as_utf8_without_unicode_error(self):
        # A cp1252 text stream (as on a Windows console) would raise UnicodeEncodeError on CJK/Greek
        # if the worker wrote text through it. Writing UTF-8 bytes to the stream's binary buffer
        # avoids that; assert the emitted bytes decode back to the exact Markdown.
        raw = io.BytesIO()
        stdout = io.TextIOWrapper(raw, encoding="cp1252")
        markdown = "# 标题\n\n段落 with Greek \u03b1 and Chinese 你好。"
        code = main(
            ["/tmp/book.pdf"],
            converter_factory=fake_factory(markdown),
            stdout=stdout,
            stderr=io.StringIO(),
        )
        stdout.flush()
        self.assertEqual(code, 0)
        self.assertEqual(raw.getvalue().decode("utf-8"), markdown)

    def test_missing_dependency_exits_with_its_own_code(self):
        def import_error_factory():
            raise ImportError("No module named 'docling'")

        stderr = io.StringIO()
        code = main(
            ["/tmp/book.pdf"],
            converter_factory=import_error_factory,
            stdout=io.StringIO(),
            stderr=stderr,
        )
        self.assertEqual(code, EXIT_MISSING_DEPENDENCY)
        self.assertIn("docling is not installed", stderr.getvalue())

    def test_conversion_failure_is_graceful_with_distinct_code_and_message(self):
        def raising_factory():
            def convert(_pdf_path):
                raise ValueError("layout model exploded")

            return types.SimpleNamespace(convert=convert)

        stderr = io.StringIO()
        code = main(
            ["/tmp/book.pdf"],
            converter_factory=raising_factory,
            stdout=io.StringIO(),
            stderr=stderr,
        )
        self.assertEqual(code, EXIT_CONVERSION_FAILED)
        self.assertNotEqual(EXIT_CONVERSION_FAILED, EXIT_MISSING_DEPENDENCY)
        self.assertIn("pdf conversion failed", stderr.getvalue())
        self.assertIn("/tmp/book.pdf", stderr.getvalue())

    def test_usage_error_when_the_pdf_argument_is_missing(self):
        stderr = io.StringIO()
        code = main([], stdout=io.StringIO(), stderr=stderr)
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("usage:", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
