"""Unit tests for the structured PDF worker (#701): pdf_to_docling.py.

No real Docling models or network: ``build_converter``'s docling imports are mocked via
``sys.modules``, and the probe/convert/mapping paths run against fakes injected through
``opener`` / ``converter_factory`` / ``prober_factory``.

Run with ``python -m unittest`` from this folder.
"""
import hashlib
import io
import json
import os
import sys
import tempfile
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
    METRICS_PATH_ENV,
    DEFAULT_PROBE_MEMORY_MIB,
    MAX_PICTURE_ARTIFACT_BYTES,
    PICTURE_LABELS,
    RANGE_SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
    ConversionFailed,
    MemoryCeilingUnsupported,
    PasswordRequired,
    UnsupportedSchema,
    ArtifactSink,
    apply_memory_limit,
    resolve_memory_boundary,
    run_check_memory_ceiling,
    write_metrics_sidecar,
    _PosixMemoryBoundary,
    _WindowsMemoryBoundary,
    _encode_png,
    _picture_image_reader,
    build_converter,
    build_document_metadata,
    build_range_payload,
    clean_metadata_value,
    convert_range,
    count_pages,
    extract_picture_artifact,
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
        # A node with no geometry ANYWHERE in its subtree keeps the inherited page (the range's first
        # page at the top level) and zeroed geometry — see ProvenanceLessGeometryTests for the #813 rule.
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
        mapped = map_group(group, FakeDoc(), identity_resolve, {}, 1)
        self.assertEqual([entry["text"] for entry in mapped], ["a", "b"])

    def test_map_group_tolerates_a_missing_group(self):
        self.assertEqual(map_group(None, FakeDoc(), identity_resolve, {}, 1), [])

    def test_resolve_ref_uses_a_docling_ref_resolver(self):
        target = FakeItem(text="resolved")

        class Ref:
            def resolve(self, _doc):
                return target

        group = FakeGroup([Ref()])
        mapped = map_group(group, FakeDoc(), lambda ref, doc: ref.resolve(doc), {}, 1)
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


# --- Provenance of a node that carries none of its own (#813) -----------------------------------


class ProvenanceLessGeometryTests(unittest.TestCase):
    """A docling group carries no ``prov``, so its page/box/span must come from the content it holds.

    Measured against the real pinned worker (docling 2.114.0, Clean Code pp.124-129) every ``list``
    group came back as ``page 1`` with a zero-area box while its ``list_item`` children were on p128/129
    — evidence that points at a page the content is not on, which silently corrupts the correction
    disclosure and any per-page coverage measure built on it.
    """

    def test_a_group_borrows_page_and_box_from_its_first_child_with_provenance(self):
        group = FakeItem(
            label="list",
            children=[
                FakeItem(
                    label="list_item",
                    prov=FakeProv(bbox=FakeBBox(72, 300, 500, 320), charspan=(0, 24), page_no=128),
                ),
                FakeItem(
                    label="list_item",
                    prov=FakeProv(bbox=FakeBBox(72, 330, 500, 350), charspan=(0, 46), page_no=128),
                ),
            ],
        )
        mapped = map_item(group, FakeDoc(), identity_resolve, {}, inherited_page=124)
        self.assertEqual(mapped["pageNumber"], 128)
        # The FIRST descendant's box verbatim — not a union across the list, which would describe a
        # region no single item occupies.
        self.assertEqual(
            mapped["boundingBox"], {"left": 72.0, "top": 300.0, "right": 500.0, "bottom": 320.0}
        )
        # First descendant's start through the last same-page descendant's end.
        self.assertEqual(mapped["charSpan"], [0, 46])

    def test_a_group_resolves_through_a_provenance_less_first_child(self):
        # The first child is itself a group with no provenance: the search is pre-order over the whole
        # subtree, not a scan of direct children only.
        inner = FakeItem(
            label="inline",
            children=[
                FakeItem(
                    label="text",
                    prov=FakeProv(bbox=FakeBBox(10, 20, 30, 40), charspan=(4, 9), page_no=57),
                )
            ],
        )
        group = FakeItem(
            label="list",
            children=[inner, FakeItem(label="text", prov=FakeProv(charspan=(0, 12), page_no=57))],
        )
        mapped = map_item(group, FakeDoc(), identity_resolve, {}, inherited_page=50)
        self.assertEqual(mapped["pageNumber"], 57)
        self.assertEqual(
            mapped["boundingBox"], {"left": 10.0, "top": 20.0, "right": 30.0, "bottom": 40.0}
        )
        self.assertEqual(mapped["charSpan"], [4, 12])
        # The nested group resolves from its own descendant too, rather than inheriting page 50.
        self.assertEqual(mapped["children"][0]["pageNumber"], 57)
        self.assertEqual(mapped["children"][0]["charSpan"], [4, 9])

    def test_a_group_with_no_provenance_anywhere_never_claims_page_one(self):
        group = FakeItem(
            label="list", children=[FakeItem(label="inline", children=[FakeItem(label="text")])]
        )
        mapped = map_item(group, FakeDoc(), identity_resolve, {}, inherited_page=311)
        self.assertEqual(mapped["pageNumber"], 311)
        self.assertEqual(
            mapped["boundingBox"], {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
        )
        self.assertEqual(mapped["charSpan"], [0, 0])
        # Every descendant of an unresolvable node inherits the same fallback, not the constant 1.
        self.assertEqual(mapped["children"][0]["pageNumber"], 311)

    def test_a_multi_page_group_takes_the_first_page_and_a_span_that_stays_on_it(self):
        group = FakeItem(
            label="list",
            children=[
                FakeItem(
                    label="list_item",
                    prov=FakeProv(bbox=FakeBBox(72, 300, 500, 320), charspan=(0, 20), page_no=128),
                ),
                FakeItem(label="list_item", prov=FakeProv(charspan=(0, 41), page_no=128)),
                FakeItem(label="list_item", prov=FakeProv(charspan=(0, 900), page_no=129)),
            ],
        )
        mapped = map_item(group, FakeDoc(), identity_resolve, {}, inherited_page=1)
        self.assertEqual(mapped["pageNumber"], 128)
        # The span ends with the last descendant ON PAGE 128; the page-129 child never extends it.
        self.assertEqual(mapped["charSpan"], [0, 41])
        self.assertEqual(
            mapped["boundingBox"], {"left": 72.0, "top": 300.0, "right": 500.0, "bottom": 320.0}
        )
        # Children keep their own pages; only the container borrowed.
        self.assertEqual([child["pageNumber"] for child in mapped["children"]], [128, 128, 129])

    def test_a_borrowed_span_is_ordered_so_the_contract_stays_valid(self):
        # Char spans are item-relative (out of scope here), so the last same-page descendant's end can
        # sit before the first's start. The contract requires charSpan start <= end regardless.
        group = FakeItem(
            label="list",
            children=[
                FakeItem(prov=FakeProv(charspan=(40, 90), page_no=6)),
                FakeItem(prov=FakeProv(charspan=(0, 12), page_no=6)),
            ],
        )
        mapped = map_item(group, FakeDoc(), identity_resolve, {}, inherited_page=1)
        self.assertEqual(mapped["charSpan"], [12, 40])

    def test_a_group_reads_the_page_confidence_of_the_page_it_resolved_to(self):
        # Confidence resolution itself is unchanged (item -> page -> 1.0); it simply now keys on the
        # page the group is really on instead of the fallback.
        group = FakeItem(label="list", children=[FakeItem(prov=FakeProv(page_no=3))])
        mapped = map_item(group, FakeDoc(), identity_resolve, {1: 0.1, 3: 0.8}, inherited_page=1)
        self.assertEqual(mapped["confidence"], 0.8)

    def test_a_range_starting_after_page_one_never_reports_page_one(self):
        # The end-to-end #813 regression: a pp.124-129 range whose list group claimed page 1.
        listing = FakeItem(
            label="list",
            children=[
                FakeItem(
                    label="list_item",
                    prov=FakeProv(bbox=FakeBBox(72, 300, 500, 320), charspan=(0, 3), page_no=128),
                ),
                FakeItem(label="list_item", prov=FakeProv(charspan=(0, 46), page_no=128)),
            ],
        )
        unresolvable = FakeItem(label="inline")
        doc = FakeDoc(
            body=FakeGroup([listing, unresolvable]),
            furniture=FakeGroup([FakeItem(label="page_header")]),
        )
        payload = build_range_payload(doc, 124, 129, native_text=lambda _p: True)
        self.assertEqual(payload["body"][0]["pageNumber"], 128)
        self.assertEqual(payload["body"][0]["charSpan"], [0, 46])
        self.assertEqual(
            payload["body"][0]["boundingBox"],
            {"left": 72.0, "top": 300.0, "right": 500.0, "bottom": 320.0},
        )
        # Nothing resolvable at all -> the RANGE's first page, never the constant 1.
        self.assertEqual(payload["body"][1]["pageNumber"], 124)
        self.assertEqual(payload["furniture"][0]["pageNumber"], 124)
        pages = [item["pageNumber"] for item in payload["body"] + payload["furniture"]]
        self.assertTrue(all(124 <= page <= 129 for page in pages), pages)


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


# --- Memory ceiling: the one worker-owned boundary contract (#782) ----------------------------


class _FakeWin32JobApi:
    """A fake pywin32 Job Object seam recording create/configure/assign, driving the Windows boundary."""

    JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100
    JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

    def __init__(self, *, peak=None, fail_on=None):
        self.calls = []
        self.info = {
            "BasicLimitInformation": {"LimitFlags": 0},
            "ProcessMemoryLimit": 0,
            "JobMemoryLimit": 0,
            "PeakJobMemoryUsed": peak,
        }
        self._fail_on = fail_on

    def create_job_object(self):
        self.calls.append("create")
        if self._fail_on == "create":
            raise OSError("CreateJobObject failed")
        return object()

    def query_extended_limit(self, _job):
        self.calls.append("query")
        return self.info

    def set_extended_limit(self, _job, info):
        self.calls.append("set")
        if self._fail_on == "set":
            raise OSError("SetInformationJobObject failed")
        self.info = info

    def assign_current_process(self, _job):
        self.calls.append("assign")
        if self._fail_on == "assign":
            raise OSError("AssignProcessToJobObject failed")


class MemoryLimitTests(unittest.TestCase):
    def test_no_ceiling_requested_is_a_noop_without_a_boundary(self):
        # No env (mib None) requests no ceiling, so a host without any boundary is fine.
        apply_memory_limit(None, None)  # must not raise

    def test_requested_ceiling_without_a_boundary_is_refused(self):
        # A positive ceiling requested but no boundary available (POSIX `resource` absent or Windows
        # without pywin32) must fail closed rather than run unbounded — the #701 invariant.
        with self.assertRaises(MemoryCeilingUnsupported) as caught:
            apply_memory_limit("512", None)
        self.assertEqual(caught.exception.mib, 512)

    def test_absent_or_non_numeric_env_is_ignored(self):
        recorder = types.SimpleNamespace(calls=[], RLIMIT_AS=object())
        recorder.setrlimit = lambda which, pair: recorder.calls.append((which, pair))
        boundary = _PosixMemoryBoundary(recorder)
        apply_memory_limit(None, boundary)
        apply_memory_limit("not-a-number", boundary)
        apply_memory_limit("0", boundary)
        apply_memory_limit("-5", boundary)
        self.assertEqual(recorder.calls, [])

    def test_non_positive_env_is_ignored_even_without_a_boundary(self):
        # A zero/negative/non-numeric request is "no ceiling", so it never raises without a boundary.
        apply_memory_limit("0", None)
        apply_memory_limit("-5", None)
        apply_memory_limit("not-a-number", None)

    def test_posix_boundary_sets_the_address_space_rlimit(self):
        recorder = types.SimpleNamespace(calls=[], RLIMIT_AS="AS")
        recorder.setrlimit = lambda which, pair: recorder.calls.append((which, pair))
        apply_memory_limit("256", _PosixMemoryBoundary(recorder))
        self.assertEqual(recorder.calls, [("AS", (256 * 1024 * 1024, 256 * 1024 * 1024))])

    def test_posix_boundary_reports_no_worker_peak(self):
        # POSIX peak stays the harness's external sampler, so the worker-side boundary has no peak.
        self.assertIsNone(_PosixMemoryBoundary(object()).peak_bytes())

    def test_windows_boundary_creates_configures_and_assigns_the_job(self):
        api = _FakeWin32JobApi(peak=7 * 1024 * 1024)
        boundary = _WindowsMemoryBoundary(api)
        apply_memory_limit("128", boundary)
        # It creates the unnamed job, sets the three limit flags + both memory limits, then assigns self.
        self.assertEqual(api.calls, ["create", "query", "set", "assign"])
        flags = api.info["BasicLimitInformation"]["LimitFlags"]
        self.assertTrue(flags & api.JOB_OBJECT_LIMIT_PROCESS_MEMORY)
        self.assertTrue(flags & api.JOB_OBJECT_LIMIT_JOB_MEMORY)
        self.assertTrue(flags & api.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
        self.assertEqual(api.info["ProcessMemoryLimit"], 128 * 1024 * 1024)
        self.assertEqual(api.info["JobMemoryLimit"], 128 * 1024 * 1024)
        # Peak is read back from the job's accounting.
        self.assertEqual(boundary.peak_bytes(), 7 * 1024 * 1024)

    def test_windows_boundary_peak_is_none_before_apply(self):
        self.assertIsNone(_WindowsMemoryBoundary(_FakeWin32JobApi()).peak_bytes())

    def test_windows_boundary_zero_peak_reports_none(self):
        api = _FakeWin32JobApi(peak=0)
        boundary = _WindowsMemoryBoundary(api)
        apply_memory_limit("64", boundary)
        self.assertIsNone(boundary.peak_bytes())

    def test_windows_boundary_create_failure_is_refused(self):
        with self.assertRaises(MemoryCeilingUnsupported):
            apply_memory_limit("64", _WindowsMemoryBoundary(_FakeWin32JobApi(fail_on="create")))

    def test_windows_boundary_configure_failure_is_refused(self):
        with self.assertRaises(MemoryCeilingUnsupported):
            apply_memory_limit("64", _WindowsMemoryBoundary(_FakeWin32JobApi(fail_on="set")))

    def test_windows_boundary_assign_failure_is_refused(self):
        with self.assertRaises(MemoryCeilingUnsupported):
            apply_memory_limit("64", _WindowsMemoryBoundary(_FakeWin32JobApi(fail_on="assign")))


class ResolveMemoryBoundaryTests(unittest.TestCase):
    def test_posix_resolves_the_rlimit_boundary(self):
        resource_module = types.SimpleNamespace(RLIMIT_AS="AS", setrlimit=lambda *_: None)
        boundary = resolve_memory_boundary(
            "linux", posix_loader=lambda: resource_module, windows_loader=lambda: None
        )
        self.assertIsInstance(boundary, _PosixMemoryBoundary)

    def test_posix_without_resource_is_unsupported(self):
        boundary = resolve_memory_boundary(
            "linux", posix_loader=lambda: None, windows_loader=lambda: None
        )
        self.assertIsNone(boundary)

    def test_windows_resolves_the_job_object_boundary(self):
        api = _FakeWin32JobApi()
        boundary = resolve_memory_boundary(
            "win32", posix_loader=lambda: None, windows_loader=lambda: api
        )
        self.assertIsInstance(boundary, _WindowsMemoryBoundary)

    def test_windows_without_pywin32_is_unsupported(self):
        boundary = resolve_memory_boundary(
            "win32", posix_loader=lambda: None, windows_loader=lambda: None
        )
        self.assertIsNone(boundary)


class CheckMemoryCeilingTests(unittest.TestCase):
    def test_capable_boundary_reports_enforced_ceiling(self):
        stdout = io.StringIO()
        code = run_check_memory_ceiling("128", _WindowsMemoryBoundary(_FakeWin32JobApi()), stdout, io.StringIO())
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(json.loads(stdout.getvalue()), {"ceilingEnforced": True, "memoryMib": 128})

    def test_missing_boundary_reports_unsupported(self):
        stderr = io.StringIO()
        code = run_check_memory_ceiling("128", None, io.StringIO(), stderr)
        self.assertEqual(code, EXIT_MEMORY_CEILING_UNSUPPORTED)
        self.assertIn("could not be enforced", stderr.getvalue())

    def test_absent_ceiling_uses_the_default_probe_mib(self):
        stdout = io.StringIO()
        code = run_check_memory_ceiling(None, _PosixMemoryBoundary(
            types.SimpleNamespace(RLIMIT_AS="AS", setrlimit=lambda *_: None)
        ), stdout, io.StringIO())
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(json.loads(stdout.getvalue())["memoryMib"], DEFAULT_PROBE_MEMORY_MIB)

    def test_non_numeric_or_non_positive_ceiling_falls_back_to_default(self):
        recorder = types.SimpleNamespace(RLIMIT_AS="AS", setrlimit=lambda *_: None)
        for raw in ("not-a-number", "0", "-9"):
            stdout = io.StringIO()
            code = run_check_memory_ceiling(raw, _PosixMemoryBoundary(recorder), stdout, io.StringIO())
            self.assertEqual(code, EXIT_OK)
            self.assertEqual(json.loads(stdout.getvalue())["memoryMib"], DEFAULT_PROBE_MEMORY_MIB)


class MetricsSidecarTests(unittest.TestCase):
    class _FakeHandle:
        def __init__(self):
            self.written = ""
            self.closed = False

        def write(self, text):
            self.written += text

        def close(self):
            self.closed = True

    def test_writes_peak_when_path_and_peak_present(self):
        handle = self._FakeHandle()
        boundary = _WindowsMemoryBoundary(_FakeWin32JobApi(peak=9 * 1024 * 1024))
        apply_memory_limit("64", boundary)
        write_metrics_sidecar("/tmp/metrics.json", boundary, opener=lambda _p: handle)
        self.assertEqual(json.loads(handle.written), {"peakMemoryBytes": 9 * 1024 * 1024})
        self.assertTrue(handle.closed)

    def test_no_path_writes_nothing(self):
        opened = []
        write_metrics_sidecar(None, _WindowsMemoryBoundary(_FakeWin32JobApi(peak=1)), opener=lambda p: opened.append(p))
        self.assertEqual(opened, [])

    def test_no_boundary_writes_nothing(self):
        opened = []
        write_metrics_sidecar("/tmp/m.json", None, opener=lambda p: opened.append(p))
        self.assertEqual(opened, [])

    def test_none_peak_writes_nothing(self):
        opened = []
        # A POSIX boundary reports no worker peak, so nothing is written even with a path.
        write_metrics_sidecar(
            "/tmp/m.json", _PosixMemoryBoundary(object()), opener=lambda p: opened.append(p)
        )
        self.assertEqual(opened, [])

    def test_open_failure_is_swallowed(self):
        boundary = _WindowsMemoryBoundary(_FakeWin32JobApi(peak=5))
        apply_memory_limit("64", boundary)

        def failing_opener(_path):
            raise OSError("cannot open")

        # Must not raise — metrics are diagnostics, never a reason to fail a good conversion.
        write_metrics_sidecar("/tmp/m.json", boundary, opener=failing_opener)



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
            boundary=None,
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
            boundary=None,
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
            boundary=None,
            stdout=io.StringIO(),
            stderr=stderr,
        )
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("usage error", stderr.getvalue())

    def test_range_rejects_end_before_start(self):
        stderr = io.StringIO()
        code = main(
            ["--range", "/tmp/a.pdf", "5", "2"],
            boundary=None,
            stdout=io.StringIO(),
            stderr=stderr,
        )
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("end page must be", stderr.getvalue())

    def test_unknown_mode_is_a_usage_error(self):
        stderr = io.StringIO()
        code = main(["--nope"], boundary=None, stdout=io.StringIO(), stderr=stderr)
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
                boundary=None,
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
            boundary=None,
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["pageCount"], 1)
        self.assertEqual(payload["pages"][0]["hasNativeText"], True)
        self.assertEqual(payload["pages"][0]["rotation"], 0)

    def test_check_memory_ceiling_mode_dispatches(self):
        # The capability-probe mode exercises the injected boundary and reports readiness without a file.
        stdout = io.StringIO()
        code = main(
            ["--check-memory-ceiling"],
            boundary=_WindowsMemoryBoundary(_FakeWin32JobApi()),
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, EXIT_OK)
        self.assertTrue(json.loads(stdout.getvalue())["ceilingEnforced"])

    def test_check_memory_ceiling_mode_reports_unsupported(self):
        stderr = io.StringIO()
        code = main(["--check-memory-ceiling"], boundary=None, stdout=io.StringIO(), stderr=stderr)
        self.assertEqual(code, EXIT_MEMORY_CEILING_UNSUPPORTED)

    def test_successful_run_writes_the_metrics_sidecar(self):
        # A successful probe writes peak memory through the injected metrics writer; a failure does not.
        calls = []
        boundary = _WindowsMemoryBoundary(_FakeWin32JobApi(peak=3))
        previous = os.environ.get(METRICS_PATH_ENV)
        os.environ[METRICS_PATH_ENV] = "/tmp/metrics.json"
        try:
            code = main(
                ["--probe", "/tmp/a.pdf"],
                opener=lambda _p: FakeBackendDoc(1),
                boundary=boundary,
                stdout=io.StringIO(),
                stderr=io.StringIO(),
                metrics_writer=lambda path, b: calls.append((path, b)),
            )
        finally:
            if previous is None:
                os.environ.pop(METRICS_PATH_ENV, None)
            else:
                os.environ[METRICS_PATH_ENV] = previous
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(calls, [("/tmp/metrics.json", boundary)])

    def test_failed_run_does_not_write_the_metrics_sidecar(self):
        calls = []
        code = main(
            ["--range", "/tmp/a.pdf", "0", "2"],  # usage error -> not EXIT_OK
            boundary=None,
            stdout=io.StringIO(),
            stderr=io.StringIO(),
            metrics_writer=lambda path, b: calls.append((path, b)),
        )
        self.assertEqual(code, EXIT_USAGE)
        self.assertEqual(calls, [])


@unittest.skipUnless(sys.platform == "win32", "Windows Job Object enforcement is Windows-only")
class WindowsMemoryCeilingEnforcementTests(unittest.TestCase):
    """A REAL child-process contract test (#782): apply a deliberately small Windows ceiling and exceed it.

    This proves the Job Object memory limit is actually enforced (an over-ceiling allocation fails), or —
    where pywin32 is unavailable — that the worker returns the typed unsupported result. Asserting the
    Job Object calls fired would be insufficient; this spawns a real interpreter under a real ceiling.
    """

    def _run_child(self, script):
        import subprocess

        worker_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            cwd=worker_dir,
            timeout=60,
        )

    def test_small_ceiling_is_enforced_or_reports_unsupported(self):
        # The child imports the worker, resolves the real Windows boundary, applies a 128 MiB ceiling, then
        # tries to allocate ~1 GiB. Under an enforced Job Object limit the allocation raises MemoryError;
        # without pywin32 the boundary is None and apply raises MemoryCeilingUnsupported.
        script = (
            "import sys\n"
            "from pdf_to_docling import resolve_memory_boundary, apply_memory_limit, "
            "MemoryCeilingUnsupported\n"
            "boundary = resolve_memory_boundary('win32')\n"
            "if boundary is None:\n"
            "    print('UNSUPPORTED'); sys.exit(8)\n"
            "try:\n"
            "    apply_memory_limit('128', boundary)\n"
            "except MemoryCeilingUnsupported:\n"
            "    print('UNSUPPORTED'); sys.exit(8)\n"
            "blobs = []\n"
            "try:\n"
            "    for _ in range(16):\n"
            "        blobs.append(bytearray(64 * 1024 * 1024))\n"
            "except MemoryError:\n"
            "    print('ENFORCED'); sys.exit(0)\n"
            "print('UNBOUNDED'); sys.exit(1)\n"
        )
        result = self._run_child(script)
        self.assertIn(
            result.returncode,
            (0, 8),
            msg=f"expected enforcement (0) or unsupported (8); got {result.returncode}: "
            f"{result.stdout}{result.stderr}",
        )
        self.assertNotIn("UNBOUNDED", result.stdout)
        self.assertIn(result.stdout.strip(), ("ENFORCED", "UNSUPPORTED"))


# --- Picture artifact extraction (#807) --------------------------------------------------------


class FakeImage:
    """A stand-in for the PIL image docling's PictureItem.get_image returns: has width/height and a
    ``save(fp, format=...)`` that writes deterministic bytes, so the encode/hash/manifest logic tests
    without Pillow or real docling models."""

    def __init__(self, width=4, height=3, data=b"\x89PNG-fake-bytes"):
        self.width = width
        self.height = height
        self._data = data

    def save(self, fp, format=None):
        assert format == "PNG", f"expected PNG, got {format}"
        fp.write(self._data)


def picture_item(image=None, label="picture", text="", children=None, page_no=1):
    """A FakeItem for a picture, optionally exposing a ``get_image`` seam returning ``image``."""
    item = FakeItem(label=label, text=text, children=children, prov=FakeProv(page_no=page_no))
    if image is not None:
        item.get_image = lambda _doc, _img=image: _img
    return item


class PictureImageReaderTests(unittest.TestCase):
    def test_returns_none_when_item_has_no_getter(self):
        self.assertIsNone(_picture_image_reader(FakeItem(label="picture"), FakeDoc()))

    def test_returns_the_image_from_the_getter(self):
        image = FakeImage()
        self.assertIs(_picture_image_reader(picture_item(image=image), FakeDoc()), image)


class ExtractPictureArtifactTests(unittest.TestCase):
    def test_writes_a_png_and_returns_a_manifest_ref(self):
        image = FakeImage(width=8, height=6, data=b"\x89PNG-body")
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: image)
            ref = extract_picture_artifact(picture_item(image=image), FakeDoc(), sink)
            self.assertEqual(ref["path"], "fig-0.png")
            self.assertEqual(ref["contentType"], "image/png")
            self.assertEqual(ref["byteLength"], len(b"\x89PNG-body"))
            self.assertEqual(ref["width"], 8)
            self.assertEqual(ref["height"], 6)
            self.assertEqual(ref["sha256"], hashlib.sha256(b"\x89PNG-body").hexdigest())
            written = os.path.join(directory, "fig-0.png")
            with open(written, "rb") as handle:
                self.assertEqual(handle.read(), b"\x89PNG-body")
            # No leftover temp file remains beside the finished artifact.
            self.assertEqual(sorted(os.listdir(directory)), ["fig-0.png"])

    def test_returns_none_and_writes_nothing_when_no_image(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: None)
            self.assertIsNone(extract_picture_artifact(FakeItem(label="picture"), FakeDoc(), sink))
            self.assertEqual(os.listdir(directory), [])

    def test_returns_none_when_the_png_exceeds_the_byte_ceiling(self):
        big = FakeImage(data=b"x" * 100)
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: big, max_bytes=10)
            self.assertIsNone(extract_picture_artifact(picture_item(image=big), FakeDoc(), sink))
            self.assertEqual(os.listdir(directory), [])

    def test_assigns_distinct_names_to_successive_pictures(self):
        image = FakeImage()
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: image)
            first = extract_picture_artifact(picture_item(image=image), FakeDoc(), sink)
            second = extract_picture_artifact(picture_item(image=image), FakeDoc(), sink)
            self.assertEqual([first["path"], second["path"]], ["fig-0.png", "fig-1.png"])

    def test_encode_png_round_trips_the_image_bytes(self):
        self.assertEqual(_encode_png(FakeImage(data=b"abc")), b"abc")


class MapItemArtifactTests(unittest.TestCase):
    def _map(self, item, sink):
        return map_item(item, FakeDoc(), lambda ref, _doc: ref, {}, 1, sink)

    def test_attaches_artifact_for_a_picture_when_a_sink_is_supplied(self):
        image = FakeImage(width=5, height=5)
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: image)
            mapped = self._map(picture_item(image=image), sink)
            self.assertEqual(mapped["imageArtifact"]["path"], "fig-0.png")
            self.assertEqual(mapped["imageArtifact"]["width"], 5)

    def test_omits_artifact_for_a_picture_that_cannot_render(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: None)
            mapped = self._map(FakeItem(label="picture"), sink)
            self.assertNotIn("imageArtifact", mapped)

    def test_does_not_extract_for_a_non_picture_label(self):
        image = FakeImage()
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: image)
            mapped = self._map(picture_item(image=image, label="text"), sink)
            self.assertNotIn("imageArtifact", mapped)
            self.assertEqual(os.listdir(directory), [])

    def test_attaches_no_artifact_without_a_sink(self):
        mapped = map_item(picture_item(image=FakeImage()), FakeDoc(), lambda ref, _doc: ref, {}, 1)
        self.assertNotIn("imageArtifact", mapped)

    def test_picture_labels_covers_picture_and_figure(self):
        self.assertEqual(PICTURE_LABELS, {"picture", "figure"})


class BuildRangePayloadArtifactTests(unittest.TestCase):
    def test_extracts_body_pictures_but_not_furniture_pictures(self):
        image = FakeImage()
        body_picture = picture_item(image=image)
        furniture_picture = picture_item(image=image)
        doc = FakeDoc(
            body=FakeGroup([body_picture]), furniture=FakeGroup([furniture_picture])
        )
        with tempfile.TemporaryDirectory() as directory:
            sink = ArtifactSink(directory, lambda _item, _doc: image)
            payload = build_range_payload(doc, 1, 1, native_text=lambda _p: True, sink=sink)
            self.assertIn("imageArtifact", payload["body"][0])
            self.assertNotIn("imageArtifact", payload["furniture"][0])
            # Only the body picture produced a file.
            self.assertEqual(os.listdir(directory), ["fig-0.png"])


class RunRangeArtifactTests(unittest.TestCase):
    def test_writes_artifacts_when_a_directory_is_supplied(self):
        image = FakeImage(width=7, height=9)
        doc = FakeDoc(body=FakeGroup([picture_item(image=image)]))
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            code = run_range(
                "/tmp/a.pdf",
                1,
                1,
                lambda: FakeConverter(doc),
                lambda _p: (lambda page: True),
                stdout,
                io.StringIO(),
                None,
                directory,
                lambda item, _doc: item.get_image(_doc),
            )
            self.assertEqual(code, EXIT_OK)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["body"][0]["imageArtifact"]["path"], "fig-0.png")
            self.assertEqual(os.listdir(directory), ["fig-0.png"])

    def test_extracts_nothing_when_no_directory_is_supplied(self):
        doc = FakeDoc(body=FakeGroup([picture_item(image=FakeImage())]))
        stdout = io.StringIO()
        code = run_range(
            "/tmp/a.pdf", 1, 1, lambda: FakeConverter(doc), lambda _p: (lambda page: True), stdout, io.StringIO()
        )
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertNotIn("imageArtifact", payload["body"][0])


class MainRangeArtifactDispatchTests(unittest.TestCase):
    def test_range_mode_accepts_an_artifact_directory_argument(self):
        image = FakeImage()
        doc = FakeDoc(body=FakeGroup([picture_item(image=image)]))
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            code = main(
                ["--range", "/tmp/a.pdf", "1", "1", directory],
                converter_factory=lambda: FakeConverter(doc),
                prober_factory=lambda _path: (lambda page: True),
                metadata_reader_factory=lambda _path: (lambda: {"Title": None, "Author": None}),
                boundary=None,
                stdout=stdout,
                stderr=io.StringIO(),
            )
            self.assertEqual(code, EXIT_OK)
            payload = json.loads(stdout.getvalue())
            # The default image reader seam calls item.get_image(doc), which the fake picture exposes.
            self.assertEqual(payload["body"][0]["imageArtifact"]["path"], "fig-0.png")
            self.assertEqual(os.listdir(directory), ["fig-0.png"])


if __name__ == "__main__":
    unittest.main()
