"""Unit tests for the structured PDF worker (#701): pdf_to_docling.py.

No real Docling models or network: ``build_converter``'s docling imports are mocked via
``sys.modules``, and the probe/convert/mapping paths run against fakes injected through
``opener`` / ``converter_factory`` / ``prober_factory``. Mirrors ``test_pdf_to_markdown.py``.

Run with ``python -m unittest`` from this folder.
"""
import io
import json
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pdf_to_docling import (  # noqa: E402  (path set above)
    DOCLING_SCHEMA_NAME,
    EXIT_CONVERSION_FAILED,
    EXIT_MEMORY_CEILING_UNSUPPORTED,
    EXIT_MISSING_DEPENDENCY,
    EXIT_OK,
    EXIT_PASSWORD_REQUIRED,
    EXIT_UNSUPPORTED_SCHEMA,
    EXIT_USAGE,
    MEMORY_LIMIT_ENV,
    RANGE_SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
    ConversionFailed,
    MemoryCeilingUnsupported,
    PasswordRequired,
    UnsupportedSchema,
    apply_memory_limit,
    build_converter,
    build_document_metadata,
    build_range_payload,
    clean_metadata_value,
    convert_range,
    count_pages,
    main,
    map_group,
    map_item,
    page_confidence_map,
    run_probe,
    run_range,
)

SUPPORTED = SUPPORTED_SCHEMA_VERSIONS[0]


# --- Fakes for a DoclingDocument subtree (no real docling objects) -----------------------------


class FakeBBox:
    def __init__(self, left, top, right, bottom):
        self.l, self.t, self.r, self.b = left, top, right, bottom


class FakeProv:
    def __init__(self, bbox=None, charspan=(0, 0), page_no=1):
        self.bbox = bbox if bbox is not None else FakeBBox(0, 0, 0, 0)
        self.charspan = charspan
        self.page_no = page_no


class FakeItem:
    def __init__(self, label="text", text="", prov=None, children=None, confidence=None):
        self.label = label
        self.text = text
        self.prov = [prov] if prov is not None else []
        self.children = children or []
        if confidence is not None:
            self.confidence = confidence


class FakeGroup:
    def __init__(self, children):
        self.children = children


class FakeGrade:
    def __init__(self, layout_score):
        self.layout_score = layout_score


class FakeTableCell:
    """A docling TableCell: text plus its grid offsets and header flags (no children/prov)."""

    def __init__(
        self,
        text,
        start_row_offset_idx=0,
        start_col_offset_idx=0,
        column_header=False,
        row_header=False,
        bbox=None,
    ):
        self.text = text
        self.start_row_offset_idx = start_row_offset_idx
        self.start_col_offset_idx = start_col_offset_idx
        self.column_header = column_header
        self.row_header = row_header
        self.bbox = bbox


class FakeTableData:
    def __init__(self, table_cells):
        self.table_cells = table_cells


class FakeTableItem:
    """A docling TableItem: carries NO children; its cells live in ``data.table_cells``."""

    def __init__(self, table_cells, prov=None):
        self.label = "table"
        self.text = ""
        self.prov = [prov] if prov is not None else []
        self.children = []
        self.data = FakeTableData(table_cells)


class FakeDoc:
    def __init__(self, version=SUPPORTED, body=None, furniture=None, confidence=None):
        self.version = version
        self.body = body if body is not None else FakeGroup([])
        self.furniture = furniture if furniture is not None else FakeGroup([])
        if confidence is not None:
            self.confidence = confidence


class FakeConverter:
    def __init__(self, doc):
        self._doc = doc
        self.calls = []

    def convert(self, pdf_path, page_range=None):
        self.calls.append((pdf_path, page_range))
        return types.SimpleNamespace(document=self._doc)


class FakeBackendPage:
    def __init__(self, chars=1, size=(612.0, 792.0), rotation=0):
        self._chars = chars
        self._size = size
        self._rotation = rotation

    def get_textpage(self):
        return self

    def count_chars(self):
        return self._chars

    def get_size(self):
        return self._size

    def get_rotation(self):
        return self._rotation


class FakeBackendDoc:
    def __init__(self, pages, page=None):
        self._pages = pages
        self._page = page if page is not None else FakeBackendPage()

    def __len__(self):
        return self._pages

    def __getitem__(self, index):
        return self._page


# Probe-mode test factories: build a per-page native-text / geometry predicate from a pdf path.
def native_text_factory(predicate=lambda _page: True):
    return lambda _path: predicate


def geometry_factory(box=None):
    box = box if box is not None else {"width": 612.0, "height": 792.0, "rotation": 0}
    return lambda _path: (lambda _page: dict(box))


def identity_resolve(ref, _doc):
    return ref


# --- Pure mapping ------------------------------------------------------------------------------


class MappingTests(unittest.TestCase):
    def test_map_item_keeps_raw_label_geometry_span_and_children(self):
        child = FakeItem(label="some_unknown_label", text="child", prov=FakeProv(page_no=3))
        parent = FakeItem(
            label="section_header",
            text="Heading",
            prov=FakeProv(bbox=FakeBBox(1, 2, 3, 4), charspan=(5, 9), page_no=2),
            children=[child],
        )
        mapped = map_item(parent, FakeDoc(), identity_resolve, {}, inherited_page=1)
        self.assertEqual(mapped["label"], "section_header")
        self.assertEqual(mapped["pageNumber"], 2)
        self.assertEqual(
            mapped["boundingBox"], {"left": 1.0, "top": 2.0, "right": 3.0, "bottom": 4.0}
        )
        self.assertEqual(mapped["charSpan"], [5, 9])
        self.assertEqual(mapped["text"], "Heading")
        # An unknown label survives verbatim on the child; nothing is dropped or narrowed.
        self.assertEqual(mapped["children"][0]["label"], "some_unknown_label")
        self.assertEqual(mapped["children"][0]["pageNumber"], 3)

    def test_map_item_defaults_when_provenance_is_absent(self):
        mapped = map_item(FakeItem(label="text"), FakeDoc(), identity_resolve, {}, inherited_page=7)
        # A group/synthetic node without geometry inherits the page and gets zeroed geometry.
        self.assertEqual(mapped["pageNumber"], 7)
        self.assertEqual(
            mapped["boundingBox"], {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
        )
        self.assertEqual(mapped["charSpan"], [0, 0])
        self.assertEqual(mapped["children"], [])

    def test_map_item_projects_a_docling_table_grid_into_rows_and_cells(self):
        # A real docling TableItem carries no children; its cells live in data.table_cells keyed by
        # grid offset. The worker must project that grid into the table_row -> cell contract shape the
        # canonical mapper turns into a PM table block (pre-fix it emitted no rows and fell back to an
        # `unknown` node, so a born-digital table never became a canonical table).
        cells = [
            FakeTableCell("Term", 0, 0, column_header=True, bbox=FakeBBox(40, 120, 300, 160)),
            FakeTableCell("Definition", 0, 1, column_header=True),
            FakeTableCell("Whetstone", 1, 0, row_header=True),
            FakeTableCell("A sharpening stone", 1, 1),
        ]
        # Deliberately scrambled so the assertions prove row-then-column ordering, not input order.
        scrambled = [cells[3], cells[0], cells[2], cells[1]]
        item = FakeTableItem(scrambled, prov=FakeProv(bbox=FakeBBox(40, 120, 560, 300), page_no=1))
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, inherited_page=1)

        self.assertEqual(mapped["label"], "table")
        self.assertEqual([row["label"] for row in mapped["children"]], ["table_row", "table_row"])
        header_cells = mapped["children"][0]["children"]
        self.assertEqual([c["label"] for c in header_cells], ["column_header", "column_header"])
        self.assertEqual([c["text"] for c in header_cells], ["Term", "Definition"])
        # A header cell keeps its own geometry; a cell without a bbox defaults to the zero box.
        self.assertEqual(
            header_cells[0]["boundingBox"],
            {"left": 40.0, "top": 120.0, "right": 300.0, "bottom": 160.0},
        )
        self.assertEqual(
            header_cells[1]["boundingBox"], {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
        )
        body_cells = mapped["children"][1]["children"]
        self.assertEqual([c["label"] for c in body_cells], ["row_header", "table_cell"])
        self.assertEqual([c["text"] for c in body_cells], ["Whetstone", "A sharpening stone"])

    def test_map_item_falls_back_to_children_for_a_table_with_no_cells(self):
        # An empty grid yields no rows, so map_item maps the (empty) children normally.
        item = FakeTableItem([], prov=FakeProv(page_no=1))
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, inherited_page=1)
        self.assertEqual(mapped["label"], "table")
        self.assertEqual(mapped["children"], [])
        item = FakeItem(prov=FakeProv(charspan=(9, 5)))
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, inherited_page=1)
        self.assertEqual(mapped["charSpan"], [5, 9])

    def test_confidence_prefers_item_then_page_then_default_and_clamps(self):
        # Item-level confidence wins and is clamped to [0, 1].
        over = map_item(FakeItem(confidence=2.5), FakeDoc(), identity_resolve, {}, 1)
        self.assertEqual(over["confidence"], 1.0)
        under = map_item(FakeItem(confidence=-3.0), FakeDoc(), identity_resolve, {}, 1)
        self.assertEqual(under["confidence"], 0.0)
        exact = map_item(FakeItem(confidence=0.42), FakeDoc(), identity_resolve, {}, 1)
        self.assertEqual(exact["confidence"], 0.42)
        # No item confidence -> falls back to the page's layout confidence.
        page = map_item(
            FakeItem(prov=FakeProv(page_no=2)), FakeDoc(), identity_resolve, {2: 0.3}, 1
        )
        self.assertEqual(page["confidence"], 0.3)
        # No item and no page entry -> default 1.0.
        default = map_item(FakeItem(prov=FakeProv(page_no=9)), FakeDoc(), identity_resolve, {}, 1)
        self.assertEqual(default["confidence"], 1.0)

    def test_map_group_maps_children_in_order(self):
        group = FakeGroup([FakeItem(text="a"), FakeItem(text="b")])
        mapped = map_group(group, FakeDoc(), identity_resolve, {})
        self.assertEqual([entry["text"] for entry in mapped], ["a", "b"])

    def test_map_group_tolerates_a_missing_group(self):
        self.assertEqual(map_group(None, FakeDoc(), identity_resolve, {}), [])

    def test_resolve_ref_uses_a_docling_ref_resolver(self):
        target = FakeItem(text="resolved")

        class Ref:
            def resolve(self, _doc):
                return target

        group = FakeGroup([Ref()])
        mapped = map_group(group, FakeDoc(), lambda ref, doc: ref.resolve(doc), {})
        self.assertEqual(mapped[0]["text"], "resolved")

    def test_page_confidence_map_reads_layout_scores(self):
        doc = FakeDoc(
            confidence=types.SimpleNamespace(pages={1: FakeGrade(0.9), 2: FakeGrade(0.2)})
        )
        self.assertEqual(page_confidence_map(doc), {1: 0.9, 2: 0.2})

    def test_page_confidence_map_is_empty_without_a_report(self):
        self.assertEqual(page_confidence_map(FakeDoc()), {})
        self.assertEqual(
            page_confidence_map(FakeDoc(confidence=types.SimpleNamespace(pages="nope"))), {}
        )

    def test_page_confidence_map_ignores_non_numeric_scores(self):
        doc = FakeDoc(confidence=types.SimpleNamespace(pages={1: FakeGrade("bad")}))
        self.assertEqual(page_confidence_map(doc), {})


# --- Range payload -----------------------------------------------------------------------------


class RangePayloadTests(unittest.TestCase):
    def test_build_range_payload_reports_pages_and_bodies(self):
        doc = FakeDoc(
            body=FakeGroup([FakeItem(text="body")]),
            furniture=FakeGroup([FakeItem(text="footer")]),
        )
        payload = build_range_payload(doc, 2, 3, native_text=lambda page: page == 2)
        self.assertEqual(payload["schemaVersion"], RANGE_SCHEMA_VERSION)
        self.assertEqual(payload["doclingSchema"], {"name": DOCLING_SCHEMA_NAME, "version": SUPPORTED})
        self.assertEqual(
            payload["pages"],
            [
                {"pageNumber": 2, "hasNativeText": True},
                {"pageNumber": 3, "hasNativeText": False},
            ],
        )
        self.assertEqual(payload["body"][0]["text"], "body")
        self.assertEqual(payload["furniture"][0]["text"], "footer")

    def test_build_range_payload_rejects_an_unsupported_schema(self):
        with self.assertRaises(UnsupportedSchema) as caught:
            build_range_payload(FakeDoc(version="0.0.9"), 1, 1, native_text=lambda _p: True)
        self.assertEqual(caught.exception.version, "0.0.9")

    def test_convert_range_passes_an_explicit_page_range(self):
        converter = FakeConverter(FakeDoc(body=FakeGroup([FakeItem(text="x")])))
        payload = convert_range(
            "/tmp/a.pdf", 1, 2, lambda: converter, native_text=lambda _p: True
        )
        self.assertEqual(converter.calls, [("/tmp/a.pdf", (1, 2))])
        self.assertEqual(payload["pages"][0]["pageNumber"], 1)
        self.assertNotIn("metadata", payload)

    def test_convert_range_attaches_cleaned_metadata_when_a_reader_is_given(self):
        converter = FakeConverter(FakeDoc(body=FakeGroup([FakeItem(text="x")])))
        payload = convert_range(
            "/tmp/a.pdf",
            1,
            1,
            lambda: converter,
            native_text=lambda _p: True,
            read_metadata=lambda: {"Title": "  Trimmed  ", "Author": ""},
        )
        self.assertEqual(payload["metadata"], {"title": "Trimmed", "author": None})


class DocumentMetadataTests(unittest.TestCase):
    def test_clean_metadata_value_trims_and_nullifies_blanks(self):
        self.assertEqual(clean_metadata_value("  A Title  "), "A Title")
        self.assertIsNone(clean_metadata_value("   "))
        self.assertIsNone(clean_metadata_value(""))

    def test_clean_metadata_value_nullifies_non_strings(self):
        self.assertIsNone(clean_metadata_value(None))
        self.assertIsNone(clean_metadata_value(42))

    def test_build_document_metadata_projects_title_and_author(self):
        self.assertEqual(
            build_document_metadata({"Title": " Book ", "Author": " Ada "}),
            {"title": "Book", "author": "Ada"},
        )

    def test_build_document_metadata_defaults_missing_fields_to_null(self):
        self.assertEqual(
            build_document_metadata({}),
            {"title": None, "author": None},
        )

    def test_build_range_payload_attaches_metadata_when_supplied(self):
        payload = build_range_payload(
            FakeDoc(),
            1,
            1,
            native_text=lambda _p: True,
            metadata={"Title": "T", "Author": "A"},
        )
        self.assertEqual(payload["metadata"], {"title": "T", "author": "A"})

    def test_build_range_payload_omits_metadata_when_absent(self):
        payload = build_range_payload(FakeDoc(), 1, 1, native_text=lambda _p: True)
        self.assertNotIn("metadata", payload)


# --- Page counting -----------------------------------------------------------------------------


class CountPagesTests(unittest.TestCase):
    def test_counts_pages_from_the_opener(self):
        self.assertEqual(count_pages("/tmp/a.pdf", lambda _p: FakeBackendDoc(5)), 5)

    def test_password_required_bubbles_up(self):
        def opener(_path):
            raise PasswordRequired()

        with self.assertRaises(PasswordRequired):
            count_pages("/tmp/a.pdf", opener)

    def test_other_open_failure_becomes_conversion_failed(self):
        def opener(_path):
            raise OSError("truncated")

        with self.assertRaises(ConversionFailed):
            count_pages("/tmp/a.pdf", opener)

    def test_missing_backend_import_bubbles_up(self):
        # A missing PDF backend (pypdfium2/docling) raises ImportError from the lazy import. It must
        # bubble up unwrapped so the caller classifies it as a missing dependency, not a corrupt file.
        def opener(_path):
            raise ModuleNotFoundError("No module named 'pypdfium2'")

        with self.assertRaises(ImportError):
            count_pages("/tmp/a.pdf", opener)


# --- Memory ceiling ----------------------------------------------------------------------------


class MemoryLimitTests(unittest.TestCase):
    def test_no_ceiling_requested_is_a_noop_without_a_resource_module(self):
        # No env (mib None) requests no ceiling, so a platform without `resource` is fine.
        apply_memory_limit(None, None)  # must not raise

    def test_requested_ceiling_without_resource_module_is_refused(self):
        # A positive ceiling requested but unenforceable (POSIX `resource` absent, e.g. Windows) must
        # fail closed rather than run unbounded — the #701 memory-bounded invariant.
        with self.assertRaises(MemoryCeilingUnsupported) as caught:
            apply_memory_limit("512", None)
        self.assertEqual(caught.exception.mib, 512)

    def test_absent_or_non_numeric_env_is_ignored(self):
        recorder = types.SimpleNamespace(calls=[], RLIMIT_AS=object())
        recorder.setrlimit = lambda which, pair: recorder.calls.append((which, pair))
        apply_memory_limit(None, recorder)
        apply_memory_limit("not-a-number", recorder)
        apply_memory_limit("0", recorder)
        apply_memory_limit("-5", recorder)
        self.assertEqual(recorder.calls, [])

    def test_non_positive_env_is_ignored_even_without_a_resource_module(self):
        # A zero/negative/non-numeric request is "no ceiling", so it never raises on Windows either.
        apply_memory_limit("0", None)
        apply_memory_limit("-5", None)
        apply_memory_limit("not-a-number", None)

    def test_valid_limit_sets_the_address_space_rlimit(self):
        recorder = types.SimpleNamespace(calls=[], RLIMIT_AS="AS")
        recorder.setrlimit = lambda which, pair: recorder.calls.append((which, pair))
        apply_memory_limit("256", recorder)
        self.assertEqual(recorder.calls, [("AS", (256 * 1024 * 1024, 256 * 1024 * 1024))])


# --- build_converter (docling imports mocked) --------------------------------------------------


class BuildConverterTests(unittest.TestCase):
    def test_builds_the_docling_converter_with_ocr_disabled(self):
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


# --- Mode dispatch (run_probe / run_range) -----------------------------------------------------


class RunProbeTests(unittest.TestCase):
    def test_emits_page_count_and_per_page_classification(self):
        stdout = io.StringIO()
        native = native_text_factory(lambda page: page != 2)  # page 2 is image-only
        geometry = lambda _path: (
            lambda page: {"width": 600.0, "height": 800.0, "rotation": 90 if page == 3 else 0}
        )
        code = run_probe(
            "/tmp/a.pdf", lambda _p: FakeBackendDoc(3), native, geometry, stdout, io.StringIO()
        )
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {
                "pageCount": 3,
                "pages": [
                    {"pageNumber": 1, "width": 600.0, "height": 800.0, "rotation": 0, "hasNativeText": True},
                    {"pageNumber": 2, "width": 600.0, "height": 800.0, "rotation": 0, "hasNativeText": False},
                    {"pageNumber": 3, "width": 600.0, "height": 800.0, "rotation": 90, "hasNativeText": True},
                ],
            },
        )

    def test_geometry_failure_exits_conversion_failed(self):
        def geometry(_path):
            def boom(_page):
                raise RuntimeError("page geometry unavailable")

            return boom

        stderr = io.StringIO()
        code = run_probe(
            "/tmp/a.pdf",
            lambda _p: FakeBackendDoc(1),
            native_text_factory(),
            geometry,
            io.StringIO(),
            stderr,
        )
        self.assertEqual(code, EXIT_CONVERSION_FAILED)
        self.assertIn("probe failed", stderr.getvalue())

    def test_encrypted_probe_exits_password_required(self):
        def opener(_path):
            raise PasswordRequired()

        stderr = io.StringIO()
        code = run_probe(
            "/tmp/a.pdf", opener, native_text_factory(), geometry_factory(), io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_PASSWORD_REQUIRED)
        self.assertIn("encrypted", stderr.getvalue())

    def test_corrupt_probe_exits_conversion_failed(self):
        def opener(_path):
            raise OSError("broken")

        stderr = io.StringIO()
        code = run_probe(
            "/tmp/a.pdf", opener, native_text_factory(), geometry_factory(), io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_CONVERSION_FAILED)
        self.assertIn("probe failed", stderr.getvalue())

    def test_missing_dependency_probe_exits_missing_dependency(self):
        # A missing pypdfium2/docling install must self-classify as tool_missing (exit 3), so the Node
        # adapter surfaces an actionable "run pnpm setup:pdf" remedy instead of a bare conversion error.
        def opener(_path):
            raise ModuleNotFoundError("No module named 'pypdfium2'")

        stderr = io.StringIO()
        code = run_probe(
            "/tmp/a.pdf", opener, native_text_factory(), geometry_factory(), io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_MISSING_DEPENDENCY)
        self.assertIn("setup:pdf", stderr.getvalue())


class RunRangeTests(unittest.TestCase):
    def _factory(self, doc):
        return lambda: FakeConverter(doc)

    def test_emits_a_valid_range_payload_as_utf8(self):
        doc = FakeDoc(body=FakeGroup([FakeItem(text="标题 α")]))
        raw = io.BytesIO()
        stdout = io.TextIOWrapper(raw, encoding="cp1252")
        code = run_range(
            "/tmp/a.pdf", 1, 1, self._factory(doc), lambda _p: (lambda page: True), stdout, io.StringIO()
        )
        stdout.flush()
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(raw.getvalue().decode("utf-8"))
        self.assertEqual(payload["schemaVersion"], RANGE_SCHEMA_VERSION)
        self.assertEqual(payload["body"][0]["text"], "标题 α")
        self.assertNotIn("metadata", payload)

    def test_emits_cleaned_metadata_when_a_reader_factory_is_wired(self):
        doc = FakeDoc(body=FakeGroup([FakeItem(text="ok")]))
        stdout = io.StringIO()
        code = run_range(
            "/tmp/a.pdf",
            1,
            1,
            self._factory(doc),
            lambda _p: (lambda page: True),
            stdout,
            io.StringIO(),
            lambda _path: (lambda: {"Title": " Meta Title ", "Author": None}),
        )
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["metadata"], {"title": "Meta Title", "author": None})

    def test_unsupported_schema_exits_with_its_own_code(self):
        doc = FakeDoc(version="0.0.9")
        stderr = io.StringIO()
        code = run_range(
            "/tmp/a.pdf", 1, 1, self._factory(doc), lambda _p: (lambda page: True), io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_UNSUPPORTED_SCHEMA)
        self.assertIn("unsupported DoclingDocument schema", stderr.getvalue())

    def test_password_required_exits_password_required(self):
        def prober(_path):
            raise PasswordRequired()

        stderr = io.StringIO()
        code = run_range(
            "/tmp/a.pdf", 1, 1, self._factory(FakeDoc()), prober, io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_PASSWORD_REQUIRED)
        self.assertIn("encrypted", stderr.getvalue())

    def test_conversion_failure_exits_conversion_failed(self):
        def raising_factory():
            def convert(_pdf_path, page_range=None):
                raise ValueError("layout exploded")

            return types.SimpleNamespace(convert=convert)

        stderr = io.StringIO()
        code = run_range(
            "/tmp/a.pdf", 1, 1, raising_factory, lambda _p: (lambda page: True), io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_CONVERSION_FAILED)
        self.assertIn("conversion failed", stderr.getvalue())

    def test_missing_converter_import_exits_missing_dependency(self):
        # A missing docling install surfaces as ImportError from build_converter's lazy import; the
        # range worker must classify it as tool_missing (exit 3), not a generic conversion failure.
        def raising_factory():
            raise ModuleNotFoundError("No module named 'docling'")

        stderr = io.StringIO()
        code = run_range(
            "/tmp/a.pdf", 1, 1, raising_factory, lambda _p: (lambda page: True), io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_MISSING_DEPENDENCY)
        self.assertIn("setup:pdf", stderr.getvalue())

    def test_missing_prober_import_exits_missing_dependency(self):
        # The native-text prober opens the PDF via the same lazy pypdfium2 import; a missing backend
        # there must also classify as tool_missing (exit 3) rather than a conversion failure.
        def prober(_path):
            raise ModuleNotFoundError("No module named 'pypdfium2'")

        stderr = io.StringIO()
        code = run_range(
            "/tmp/a.pdf", 1, 1, self._factory(FakeDoc()), prober, io.StringIO(), stderr
        )
        self.assertEqual(code, EXIT_MISSING_DEPENDENCY)
        self.assertIn("setup:pdf", stderr.getvalue())


# --- main() argument parsing / dispatch --------------------------------------------------------


class MainTests(unittest.TestCase):
    def test_probe_mode_dispatches(self):
        stdout = io.StringIO()
        code = main(
            ["--probe", "/tmp/a.pdf"],
            opener=lambda _p: FakeBackendDoc(3),
            resource_module=None,
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {
                "pageCount": 3,
                "pages": [
                    {
                        "pageNumber": page,
                        "width": 612.0,
                        "height": 792.0,
                        "rotation": 0,
                        "hasNativeText": True,
                    }
                    for page in (1, 2, 3)
                ],
            },
        )

    def test_range_mode_dispatches(self):
        doc = FakeDoc(body=FakeGroup([FakeItem(text="ok")]))
        stdout = io.StringIO()
        code = main(
            ["--range", "/tmp/a.pdf", "1", "2"],
            converter_factory=lambda: FakeConverter(doc),
            prober_factory=lambda _path: (lambda page: page == 1),
            metadata_reader_factory=lambda _path: (lambda: {"Title": "Doc", "Author": "Ada"}),
            resource_module=None,
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual([p["hasNativeText"] for p in payload["pages"]], [True, False])
        self.assertEqual(payload["metadata"], {"title": "Doc", "author": "Ada"})

    def test_range_rejects_non_positive_pages(self):
        stderr = io.StringIO()
        code = main(
            ["--range", "/tmp/a.pdf", "0", "2"],
            resource_module=None,
            stdout=io.StringIO(),
            stderr=stderr,
        )
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("usage error", stderr.getvalue())

    def test_range_rejects_end_before_start(self):
        stderr = io.StringIO()
        code = main(
            ["--range", "/tmp/a.pdf", "5", "2"],
            resource_module=None,
            stdout=io.StringIO(),
            stderr=stderr,
        )
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("end page must be", stderr.getvalue())

    def test_unknown_mode_is_a_usage_error(self):
        stderr = io.StringIO()
        code = main(["--nope"], resource_module=None, stdout=io.StringIO(), stderr=stderr)
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("usage:", stderr.getvalue())

    def test_unenforceable_memory_ceiling_refuses_before_dispatch(self):
        # A ceiling requested via env but no `resource` module (Windows) must refuse with a distinct
        # exit and an actionable remedy, before any probe/conversion runs.
        stderr = io.StringIO()
        previous = os.environ.get(MEMORY_LIMIT_ENV)
        os.environ[MEMORY_LIMIT_ENV] = "512"
        try:
            code = main(
                ["--probe", "/tmp/a.pdf"],
                opener=lambda _p: FakeBackendDoc(3),
                resource_module=None,
                stdout=io.StringIO(),
                stderr=stderr,
            )
        finally:
            if previous is None:
                os.environ.pop(MEMORY_LIMIT_ENV, None)
            else:
                os.environ[MEMORY_LIMIT_ENV] = previous
        self.assertEqual(code, EXIT_MEMORY_CEILING_UNSUPPORTED)
        self.assertIn("memory ceiling", stderr.getvalue())

    def test_default_prober_and_geometry_factories_are_wired_when_not_injected(self):
        # Exercise the branch that builds the default native-text + geometry factories from the opener,
        # so a probe emits a full per-page classification without an injected factory.
        stdout = io.StringIO()
        code = main(
            ["--probe", "/tmp/a.pdf"],
            opener=lambda _p: FakeBackendDoc(1),
            resource_module=None,
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["pageCount"], 1)
        self.assertEqual(payload["pages"][0]["hasNativeText"], True)
        self.assertEqual(payload["pages"][0]["rotation"], 0)


if __name__ == "__main__":
    unittest.main()
