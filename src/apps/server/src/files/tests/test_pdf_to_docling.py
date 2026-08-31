"""Unit tests for the structured PDF worker (#701): pdf_to_docling.py.

No real Docling models or network: ``build_converter``'s docling imports are mocked via
``sys.modules``, and the probe/convert/mapping paths run against fakes injected through
``opener`` / ``converter_factory`` / ``prober_factory``.

Run with ``python -m unittest`` from this folder.
"""
import contextlib
import enum
import hashlib
import io
import json
import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pdf_to_docling  # noqa: E402  (path set above)
from pdf_to_docling import (  # noqa: E402  (path set above)
    DOCLING_SCHEMA_NAME,
    EXIT_CONVERSION_FAILED,
    EXIT_CONVERSION_INCOMPLETE,
    EXIT_MEMORY,
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
    MAX_OUTLINE_DEPTH,
    MAX_OUTLINE_ENTRIES,
    MAX_OUTLINE_TITLE_CHARS,
    MAX_REPORTED_CONVERSION_ERRORS,
    MAX_REPORTED_FAILED_PAGES,
    PICTURE_LABELS,
    RANGE_SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
    ConversionFailed,
    ConversionIncomplete,
    MemoryCeilingUnsupported,
    PasswordRequired,
    UnsupportedSchema,
    ArtifactSink,
    CODE_CLUSTER_LABEL,
    CODE_CLUSTER_MATCH_TOLERANCE,
    apply_memory_limit,
    release_memory_boundary,
    resolve_memory_boundary,
    run_check_memory_ceiling,
    write_metrics_sidecar,
    _PosixMemoryBoundary,
    _WindowsMemoryBoundary,
    _cluster_bbox_bottom_left,
    _cluster_code_lines,
    _encode_png,
    _match_code_cluster_text,
    _picture_image_reader,
    _stripped_text_length,
    build_code_cluster_index,
    build_converter,
    build_document_metadata,
    build_document_outline,
    build_range_payload,
    clean_metadata_value,
    convert_range,
    count_pages,
    ensure_conversion_complete,
    ensure_pages_processed,
    extract_picture_artifact,
    load_conversion_status,
    main,
    map_group,
    map_item,
    native_text_length_prober,
    page_confidence_map,
    processed_page_numbers,
    read_outline_entries,
    read_pdf_outline,
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


class FakePage:
    """One ``ConversionResult.pages`` entry: the converter's own record that it processed this page.

    Mirrors the shape MEASURED on the real book with the pinned converter: ``page_no`` plus populated
    ``predictions``/``assembled``/``size``, and a ``parsed_page`` of ``None`` — docling RELEASES the
    parsed page after assembly, on every successfully converted page, so released state is never the
    evidence. A page the converter lost is ABSENT from ``pages`` entirely, never present-and-empty.
    """

    def __init__(self, page_no, predictions="PagePredictions", assembled="AssembledUnit", size="Size"):
        self.page_no = page_no
        self.predictions = predictions
        self.assembled = assembled
        self.parsed_page = None
        self.size = size


# --- Fakes for a page's layout-cluster record (#876: the pre-flattening code-listing evidence) -----


class FakeCodeCell:
    def __init__(self, text):
        self.text = text


class FakeCluster:
    def __init__(self, label, bbox, cells):
        self.label = label
        self.bbox = bbox
        self.cells = cells


class FakeLayout:
    def __init__(self, clusters):
        self.clusters = clusters


class FakePredictions:
    def __init__(self, layout):
        self.layout = layout


class FakeSize:
    def __init__(self, height, width=612.0):
        self.width = width
        self.height = height


def fake_cluster(label, bbox, cell_texts):
    """A FakeCluster whose cells are plain strings wrapped as FakeCodeCells, in reading order."""
    return FakeCluster(label, bbox, [FakeCodeCell(text) for text in cell_texts])


def code_cluster_page(page_no, clusters, page_height=792.0):
    """A FakePage exposing real ``predictions.layout.clusters`` (#876), unlike the placeholder string
    ``FakePage`` otherwise carries — used only where a test needs the pre-flattening layout evidence.
    """
    return FakePage(page_no, predictions=FakePredictions(FakeLayout(clusters)), size=FakeSize(page_height))


def page_evidence(page_range, processed_pages=None):
    """Per-page processing evidence as a healthy docling run reports it: one entry per requested page.

    ``processed_pages`` overrides that to model a converter that processed FEWER pages than it was
    asked for (the reproduced #843 shape) or that reports unusable page numbers.
    """
    if processed_pages is None:
        processed_pages = [] if page_range is None else list(range(page_range[0], page_range[1] + 1))
    return [page if isinstance(page, FakePage) else FakePage(page) for page in processed_pages]


class FakeConverter:
    def __init__(self, doc, pages=None):
        self._doc = doc
        self._pages = pages
        self.calls = []

    def convert(self, pdf_path, page_range=None):
        self.calls.append((pdf_path, page_range))
        # A healthy conversion REPORTS that it is healthy. Since the completeness gate fails closed
        # (#832, D8), a fake standing in for a good range must report success exactly as the real
        # docling result does; a fake that reported nothing would model a refused conversion. It must
        # also carry the per-page processing record a real run carries (#840), one entry per requested
        # page — a fake with no record would model a converter that processed nothing.
        return types.SimpleNamespace(
            document=self._doc,
            status=FakeConversionStatus.SUCCESS,
            errors=[],
            pages=self._pages if self._pages is not None else page_evidence(page_range),
        )


class FakeBackendPage:
    def __init__(self, chars=1, size=(612.0, 792.0), rotation=0, text=""):
        self._chars = chars
        self._size = size
        self._rotation = rotation
        self._text = text

    def get_textpage(self):
        return self

    def count_chars(self):
        return self._chars

    def get_text_range(self):
        return self._text

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


# --- Code-listing text reconstruction from the pre-flattening layout clusters (#876) ------------


class ClusterCodeLinesTests(unittest.TestCase):
    def test_joins_non_blank_cells_with_newlines_keeping_original_indentation(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 0, 0), ["def foo():", "    return 1"])
        self.assertEqual(_cluster_code_lines(cluster), "def foo():\n    return 1")

    def test_skips_blank_and_whitespace_only_cells(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 0, 0), ["a", "   ", "", "b"])
        self.assertEqual(_cluster_code_lines(cluster), "a\nb")

    def test_replaces_the_soft_hyphen_marker_with_a_hyphen(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 0, 0), ["foo\x02bar"])
        self.assertEqual(_cluster_code_lines(cluster), "foo-bar")

    def test_returns_none_when_every_cell_is_blank(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 0, 0), ["  ", ""])
        self.assertIsNone(_cluster_code_lines(cluster))

    def test_returns_none_for_a_cluster_with_no_cells(self):
        self.assertIsNone(_cluster_code_lines(FakeCluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 0, 0), [])))


class ClusterBboxBottomLeftTests(unittest.TestCase):
    def test_mirrors_top_and_bottom_through_the_page_height_leaving_left_and_right_unchanged(self):
        self.assertEqual(
            _cluster_bbox_bottom_left(FakeBBox(10, 20, 110, 60), 792.0),
            {"left": 10.0, "right": 110.0, "top": 772.0, "bottom": 732.0},
        )

    def test_coerces_every_field_to_a_float(self):
        result = _cluster_bbox_bottom_left(FakeBBox(1, 2, 3, 4), 100)
        for value in result.values():
            self.assertIsInstance(value, float)


class MatchCodeClusterTextTests(unittest.TestCase):
    def test_returns_the_closest_candidates_text_within_tolerance(self):
        box = {"left": 10.0, "top": 20.0, "right": 110.0, "bottom": 60.0}
        candidates = [
            ({"left": 10.0, "top": 20.0, "right": 110.0, "bottom": 60.0}, "exact"),
            ({"left": 50.0, "top": 20.0, "right": 110.0, "bottom": 60.0}, "far"),
        ]
        self.assertEqual(_match_code_cluster_text(box, candidates), "exact")

    def test_returns_none_when_nothing_is_within_tolerance(self):
        box = {"left": 10.0, "top": 20.0, "right": 110.0, "bottom": 60.0}
        candidates = [({"left": 999.0, "top": 999.0, "right": 999.0, "bottom": 999.0}, "far")]
        self.assertIsNone(_match_code_cluster_text(box, candidates))

    def test_returns_none_for_no_candidates(self):
        box = {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
        self.assertIsNone(_match_code_cluster_text(box, []))

    def test_accepts_a_match_right_at_the_tolerance_boundary(self):
        box = {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
        candidates = [
            ({"left": CODE_CLUSTER_MATCH_TOLERANCE, "top": 0.0, "right": 0.0, "bottom": 0.0}, "close")
        ]
        self.assertEqual(_match_code_cluster_text(box, candidates), "close")

    def test_rejects_a_match_just_beyond_the_tolerance_boundary(self):
        box = {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
        candidates = [
            ({"left": CODE_CLUSTER_MATCH_TOLERANCE + 0.01, "top": 0.0, "right": 0.0, "bottom": 0.0}, "far")
        ]
        self.assertIsNone(_match_code_cluster_text(box, candidates))


class BuildCodeClusterIndexTests(unittest.TestCase):
    def test_indexes_code_clusters_by_page_with_bottom_left_bbox_and_joined_text(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():", "    pass"])
        result = types.SimpleNamespace(pages=[code_cluster_page(3, [cluster], page_height=792.0)])
        index = build_code_cluster_index(result)
        self.assertEqual(list(index.keys()), [3])
        bbox, text = index[3][0]
        self.assertEqual(bbox, {"left": 10.0, "right": 110.0, "top": 772.0, "bottom": 732.0})
        self.assertEqual(text, "def f():\n    pass")

    def test_skips_non_code_labelled_clusters(self):
        cluster = fake_cluster("text", FakeBBox(0, 0, 10, 10), ["paragraph"])
        result = types.SimpleNamespace(pages=[code_cluster_page(1, [cluster])])
        self.assertEqual(build_code_cluster_index(result), {})

    def test_skips_a_code_cluster_whose_cells_are_all_blank(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 10, 10), ["   ", ""])
        result = types.SimpleNamespace(pages=[code_cluster_page(1, [cluster])])
        self.assertEqual(build_code_cluster_index(result), {})

    def test_skips_a_cluster_with_no_bbox(self):
        cluster = FakeCluster(CODE_CLUSTER_LABEL, None, [FakeCodeCell("x")])
        result = types.SimpleNamespace(pages=[code_cluster_page(1, [cluster])])
        self.assertEqual(build_code_cluster_index(result), {})

    def test_is_empty_without_pages_or_clusters(self):
        self.assertEqual(build_code_cluster_index(types.SimpleNamespace(pages=[])), {})
        self.assertEqual(build_code_cluster_index(types.SimpleNamespace()), {})
        # The placeholder FakePage() shape every other test in this file uses (plain string
        # predictions/size, no real layout) must degrade to empty too, never raise.
        self.assertEqual(build_code_cluster_index(types.SimpleNamespace(pages=[FakePage(1)])), {})

    def test_fails_soft_when_the_page_number_is_missing_or_invalid(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 10, 10), ["x"])
        for bad_page_no in (None, True, 0, -1, "1"):
            page = code_cluster_page(bad_page_no, [cluster])
            with self.subTest(page_no=bad_page_no):
                self.assertEqual(build_code_cluster_index(types.SimpleNamespace(pages=[page])), {})

    def test_fails_soft_when_predictions_layout_or_size_are_missing_or_malformed(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(0, 0, 10, 10), ["x"])
        cases = [
            FakePage(1, predictions=None, size=FakeSize(792.0)),
            FakePage(1, predictions=FakePredictions(None), size=FakeSize(792.0)),
            FakePage(1, predictions=FakePredictions(FakeLayout(None)), size=FakeSize(792.0)),
            FakePage(1, predictions=FakePredictions(FakeLayout([cluster])), size=None),
            FakePage(1, predictions=FakePredictions(FakeLayout([cluster])), size=FakeSize("tall")),
            FakePage(1, predictions=FakePredictions(FakeLayout([cluster])), size=FakeSize(True)),
        ]
        for index, page in enumerate(cases):
            with self.subTest(case=index):
                self.assertEqual(build_code_cluster_index(types.SimpleNamespace(pages=[page])), {})


class MapItemCodeClusterTests(unittest.TestCase):
    @staticmethod
    def _index(page_no, clusters, page_height=792.0):
        page = code_cluster_page(page_no, clusters, page_height=page_height)
        return build_code_cluster_index(types.SimpleNamespace(pages=[page]))

    def test_replaces_flattened_text_with_the_matching_clusters_reconstructed_lines(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():", "    return 1"])
        index = self._index(2, [cluster])
        item = FakeItem(
            label="code",
            text="def f(): return 1",
            prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=2),
        )
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, 1, code_cluster_index=index)
        self.assertEqual(mapped["text"], "def f():\n    return 1")

    def test_falls_back_to_flattened_text_when_no_cluster_is_close_enough(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():"])
        index = self._index(2, [cluster])
        item = FakeItem(
            label="code",
            text="def f(): return 1",
            prov=FakeProv(bbox=FakeBBox(400, 400, 500, 450), page_no=2),
        )
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, 1, code_cluster_index=index)
        self.assertEqual(mapped["text"], "def f(): return 1")

    def test_falls_back_when_the_items_page_has_no_indexed_clusters(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():"])
        index = self._index(2, [cluster])
        item = FakeItem(
            label="code", text="flat", prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=9)
        )
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, 1, code_cluster_index=index)
        self.assertEqual(mapped["text"], "flat")

    def test_non_code_items_are_unaffected_even_with_a_populated_index(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():"])
        index = self._index(2, [cluster])
        item = FakeItem(
            label="text",
            text="A paragraph.",
            prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=2),
        )
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, 1, code_cluster_index=index)
        self.assertEqual(mapped["text"], "A paragraph.")

    def test_two_same_page_code_items_each_match_their_own_cluster(self):
        first = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["first():"])
        second = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(200, 20, 300, 60), ["second():"])
        index = self._index(1, [first, second])
        item_a = FakeItem(
            label="code",
            text="first(): flat",
            prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=1),
        )
        item_b = FakeItem(
            label="code",
            text="second(): flat",
            prov=FakeProv(bbox=FakeBBox(200, 772, 300, 732), page_no=1),
        )
        mapped_a = map_item(item_a, FakeDoc(), identity_resolve, {}, 1, code_cluster_index=index)
        mapped_b = map_item(item_b, FakeDoc(), identity_resolve, {}, 1, code_cluster_index=index)
        self.assertEqual(mapped_a["text"], "first():")
        self.assertEqual(mapped_b["text"], "second():")

    def test_without_an_index_the_item_keeps_its_flattened_text(self):
        item = FakeItem(label="code", text="flat", prov=FakeProv(page_no=1))
        mapped = map_item(item, FakeDoc(), identity_resolve, {}, 1)
        self.assertEqual(mapped["text"], "flat")

    def test_map_group_threads_the_index_to_every_child(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():"])
        index = self._index(1, [cluster])
        item = FakeItem(
            label="code", text="flat", prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=1)
        )
        mapped = map_group(
            FakeGroup([item]), FakeDoc(), identity_resolve, {}, 1, code_cluster_index=index
        )
        self.assertEqual(mapped[0]["text"], "def f():")


class BuildRangePayloadCodeClusterTests(unittest.TestCase):
    def test_reconstructs_body_code_but_never_touches_furniture(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():", "    pass"])
        index = build_code_cluster_index(
            types.SimpleNamespace(pages=[code_cluster_page(1, [cluster])])
        )
        body_code = FakeItem(
            label="code",
            text="def f(): pass",
            prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=1),
        )
        # Furniture never carries a real code listing, but this one is deliberately given a bbox that
        # WOULD match, to prove build_range_payload never threads the index into furniture at all
        # (#876) — not merely that no furniture data happened to match.
        furniture_code = FakeItem(
            label="code",
            text="def f(): pass",
            prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=1),
        )
        doc = FakeDoc(body=FakeGroup([body_code]), furniture=FakeGroup([furniture_code]))
        payload = build_range_payload(doc, 1, 1, native_text=lambda _p: True, code_cluster_index=index)
        self.assertEqual(payload["body"][0]["text"], "def f():\n    pass")
        self.assertEqual(payload["furniture"][0]["text"], "def f(): pass")

    def test_without_a_code_cluster_index_body_code_keeps_its_flattened_text(self):
        body_code = FakeItem(label="code", text="def f(): pass", prov=FakeProv(page_no=1))
        payload = build_range_payload(
            FakeDoc(body=FakeGroup([body_code])), 1, 1, native_text=lambda _p: True
        )
        self.assertEqual(payload["body"][0]["text"], "def f(): pass")


class ConvertRangeCodeClusterTests(unittest.TestCase):
    def test_builds_the_index_from_the_full_result_and_reconstructs_body_code(self):
        cluster = fake_cluster(CODE_CLUSTER_LABEL, FakeBBox(10, 20, 110, 60), ["def f():", "    return 1"])
        body_code = FakeItem(
            label="code",
            text="def f(): return 1",
            prov=FakeProv(bbox=FakeBBox(10, 772, 110, 732), page_no=1),
        )
        doc = FakeDoc(body=FakeGroup([body_code]))
        converter = FakeConverter(doc, pages=[code_cluster_page(1, [cluster])])
        payload = convert_range("/tmp/a.pdf", 1, 1, lambda: converter, native_text=lambda _p: True)
        self.assertEqual(payload["body"][0]["text"], "def f():\n    return 1")

    def test_falls_back_to_flattened_text_when_the_layout_cluster_shape_is_absent(self):
        # The plain FakePage() placeholder every OTHER convert_range test in this file relies on (a
        # string predictions/size, no real layout) must still succeed end-to-end and emit the
        # flattened text, never raise, when #876's layout-cluster evidence is not in the expected shape.
        body_code = FakeItem(label="code", text="def f(): return 1", prov=FakeProv(page_no=1))
        converter = FakeConverter(FakeDoc(body=FakeGroup([body_code])))
        payload = convert_range("/tmp/a.pdf", 1, 1, lambda: converter, native_text=lambda _p: True)
        self.assertEqual(payload["body"][0]["text"], "def f(): return 1")


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


# --- Bookmark outline (#815) ---------------------------------------------------------------------


class FakeDest:
    """A pypdfium2 bookmark destination: resolves to a 0-based page index, or raises."""

    def __init__(self, index=0, raises=False):
        self._index = index
        self._raises = raises

    def get_index(self):
        if self._raises:
            raise RuntimeError("broken destination")
        return self._index


class FakeBookmark:
    """A pypdfium2 PdfBookmark: a 0-based ``level`` plus title/destination accessors."""

    def __init__(self, title="Chapter", level=0, dest=FakeDest(), title_raises=False):
        self.level = level
        self._title = title
        self._dest = dest
        self._title_raises = title_raises

    def get_title(self):
        if self._title_raises:
            raise RuntimeError("broken title")
        return self._title

    def get_dest(self):
        return self._dest


class FakeOutlineDoc:
    """A backend document exposing only ``get_toc``, recording the max_depth it was walked with."""

    def __init__(self, bookmarks=(), raises=False):
        self._bookmarks = list(bookmarks)
        self._raises = raises
        self.max_depths = []

    def get_toc(self, max_depth=15):
        self.max_depths.append(max_depth)
        if self._raises:
            raise RuntimeError("no outline")
        return iter(self._bookmarks)


class ReadPdfOutlineTests(unittest.TestCase):
    def test_reads_a_nested_tree_with_zero_based_levels_and_page_indexes(self):
        document = FakeOutlineDoc(
            [
                FakeBookmark("Chapter 1", level=0, dest=FakeDest(30)),
                FakeBookmark("Section 1.1", level=1, dest=FakeDest(31)),
                FakeBookmark("Detail", level=2, dest=FakeDest(32)),
            ]
        )
        self.assertEqual(
            read_pdf_outline(document),
            [
                {"title": "Chapter 1", "level": 0, "pageIndex": 30},
                {"title": "Section 1.1", "level": 1, "pageIndex": 31},
                {"title": "Detail", "level": 2, "pageIndex": 32},
            ],
        )

    def test_walks_the_tree_under_the_bounded_depth(self):
        document = FakeOutlineDoc([FakeBookmark()])
        read_pdf_outline(document)
        self.assertEqual(document.max_depths, [MAX_OUTLINE_DEPTH])

    def test_a_bookmarkless_document_reads_as_an_empty_outline(self):
        self.assertEqual(read_pdf_outline(FakeOutlineDoc([])), [])

    def test_a_destinationless_bookmark_reads_with_a_null_page(self):
        document = FakeOutlineDoc([FakeBookmark("Orphan", dest=None)])
        self.assertEqual(
            read_pdf_outline(document), [{"title": "Orphan", "level": 0, "pageIndex": None}]
        )

    def test_one_broken_bookmark_is_dropped_and_the_rest_survive(self):
        document = FakeOutlineDoc(
            [
                FakeBookmark("Good", dest=FakeDest(1)),
                FakeBookmark("Broken destination", dest=FakeDest(raises=True)),
                FakeBookmark("Broken title", title_raises=True),
                FakeBookmark("Also good", level=1, dest=FakeDest(2)),
            ]
        )
        self.assertEqual(
            [entry["title"] for entry in read_pdf_outline(document)], ["Good", "Also good"]
        )

    def test_an_over_limit_tree_is_truncated_to_the_entry_bound(self):
        document = FakeOutlineDoc(
            [FakeBookmark(f"Entry {index}") for index in range(MAX_OUTLINE_ENTRIES + 25)]
        )
        self.assertEqual(len(read_pdf_outline(document)), MAX_OUTLINE_ENTRIES)


class BuildDocumentOutlineTests(unittest.TestCase):
    def test_projects_levels_and_pages_to_the_one_based_contract(self):
        self.assertEqual(
            build_document_outline(
                [
                    {"title": "  Chapter 6: Objects  ", "level": 0, "pageIndex": 123},
                    {"title": "Data Abstraction", "level": 1, "pageIndex": 123},
                ]
            ),
            [
                {"title": "Chapter 6: Objects", "level": 1, "pageNumber": 124},
                {"title": "Data Abstraction", "level": 2, "pageNumber": 124},
            ],
        )

    def test_drops_entries_that_cannot_be_located_or_named(self):
        self.assertEqual(
            build_document_outline(
                [
                    {"title": "No page", "level": 0, "pageIndex": None},
                    {"title": "   ", "level": 0, "pageIndex": 1},
                    {"title": None, "level": 0, "pageIndex": 1},
                    {"title": "Bad level", "level": "1", "pageIndex": 1},
                    {"title": "Negative level", "level": -1, "pageIndex": 1},
                    {"title": "Negative page", "level": 0, "pageIndex": -1},
                    {"title": "Boolean level", "level": True, "pageIndex": 1},
                    {"title": "Boolean page", "level": 0, "pageIndex": True},
                    "not a mapping",
                    {"title": "Kept", "level": 0, "pageIndex": 0},
                ]
            ),
            [{"title": "Kept", "level": 1, "pageNumber": 1}],
        )

    def test_truncates_an_over_long_title(self):
        [entry] = build_document_outline(
            [{"title": "x" * (MAX_OUTLINE_TITLE_CHARS + 40), "level": 0, "pageIndex": 0}]
        )
        self.assertEqual(entry["title"], "x" * MAX_OUTLINE_TITLE_CHARS)

    def test_truncates_an_over_long_outline(self):
        raw = [
            {"title": f"Entry {index}", "level": 0, "pageIndex": index}
            for index in range(MAX_OUTLINE_ENTRIES + 10)
        ]
        self.assertEqual(len(build_document_outline(raw)), MAX_OUTLINE_ENTRIES)


class ReadOutlineEntriesTests(unittest.TestCase):
    def test_an_unwired_seam_yields_no_outline_at_all(self):
        self.assertIsNone(read_outline_entries(None))

    def test_a_raising_seam_yields_an_empty_outline_rather_than_failing(self):
        def read():
            raise RuntimeError("pypdfium2 exploded")

        self.assertEqual(read_outline_entries(read), [])

    def test_a_wired_seam_projects_its_entries(self):
        self.assertEqual(
            read_outline_entries(lambda: [{"title": "Intro", "level": 0, "pageIndex": 4}]),
            [{"title": "Intro", "level": 1, "pageNumber": 5}],
        )


class RangeOutlinePayloadTests(unittest.TestCase):
    def test_build_range_payload_attaches_the_outline_when_supplied(self):
        payload = build_range_payload(
            FakeDoc(),
            1,
            1,
            native_text=lambda _p: True,
            outline=[{"title": "Chapter 1", "level": 1, "pageNumber": 3}],
        )
        self.assertEqual(payload["outline"], [{"title": "Chapter 1", "level": 1, "pageNumber": 3}])

    def test_build_range_payload_attaches_an_empty_outline_distinctly_from_none(self):
        self.assertEqual(
            build_range_payload(FakeDoc(), 1, 1, native_text=lambda _p: True, outline=[])["outline"],
            [],
        )

    def test_build_range_payload_omits_the_outline_when_absent(self):
        payload = build_range_payload(FakeDoc(), 1, 1, native_text=lambda _p: True)
        self.assertNotIn("outline", payload)

    def test_convert_range_projects_the_outline_seam(self):
        converter = FakeConverter(FakeDoc(body=FakeGroup([FakeItem(text="x")])))
        payload = convert_range(
            "/tmp/a.pdf",
            1,
            1,
            lambda: converter,
            native_text=lambda _p: True,
            read_outline=lambda: [{"title": "Preface", "level": 0, "pageIndex": 8}],
        )
        self.assertEqual(payload["outline"], [{"title": "Preface", "level": 1, "pageNumber": 9}])

    def test_convert_range_survives_an_outline_read_failure(self):
        converter = FakeConverter(FakeDoc(body=FakeGroup([FakeItem(text="x")])))

        def read_outline():
            raise RuntimeError("broken")

        payload = convert_range(
            "/tmp/a.pdf", 1, 1, lambda: converter, native_text=lambda _p: True, read_outline=read_outline
        )
        self.assertEqual(payload["outline"], [])
        self.assertEqual(payload["body"][0]["text"], "x")

    def test_run_range_emits_the_outline_from_its_factory(self):
        doc = FakeDoc(body=FakeGroup([FakeItem(text="ok")]))
        stdout = io.StringIO()
        code = run_range(
            "/tmp/a.pdf",
            1,
            1,
            lambda: FakeConverter(doc),
            lambda _p: (lambda page: True),
            stdout,
            io.StringIO(),
            outline_reader_factory=lambda _path: (
                lambda: [{"title": "Chapter 2", "level": 1, "pageIndex": 40}]
            ),
        )
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(
            json.loads(stdout.getvalue())["outline"],
            [{"title": "Chapter 2", "level": 2, "pageNumber": 41}],
        )

    def test_run_range_omits_the_outline_without_a_factory(self):
        doc = FakeDoc(body=FakeGroup([FakeItem(text="ok")]))
        stdout = io.StringIO()
        run_range(
            "/tmp/a.pdf",
            1,
            1,
            lambda: FakeConverter(doc),
            lambda _p: (lambda page: True),
            stdout,
            io.StringIO(),
        )
        self.assertNotIn("outline", json.loads(stdout.getvalue()))


# --- Native text length / coverage (#817) -------------------------------------------------------


class StrippedTextLengthTests(unittest.TestCase):
    def test_removes_every_whitespace_run_rather_than_collapsing_it(self):
        self.assertEqual(_stripped_text_length("Hello   world\n\tfoo"), len("Helloworldfoo"))

    def test_empty_and_whitespace_only_text_is_zero(self):
        self.assertEqual(_stripped_text_length(""), 0)
        self.assertEqual(_stripped_text_length("   \n\t  "), 0)


class NativeTextLengthPayloadTests(unittest.TestCase):
    def test_build_range_payload_attaches_native_text_length_when_supplied(self):
        payload = build_range_payload(
            FakeDoc(),
            1,
            2,
            native_text=lambda _p: True,
            native_text_length=lambda page: 42 if page == 1 else 7,
        )
        self.assertEqual(
            payload["pages"],
            [
                {"pageNumber": 1, "hasNativeText": True, "nativeTextLength": 42},
                {"pageNumber": 2, "hasNativeText": True, "nativeTextLength": 7},
            ],
        )

    def test_build_range_payload_attaches_a_zero_native_text_length_distinctly_from_omitted(self):
        payload = build_range_payload(
            FakeDoc(), 1, 1, native_text=lambda _p: False, native_text_length=lambda _p: 0
        )
        self.assertIn("nativeTextLength", payload["pages"][0])
        self.assertEqual(payload["pages"][0]["nativeTextLength"], 0)

    def test_build_range_payload_omits_native_text_length_when_absent(self):
        payload = build_range_payload(FakeDoc(), 1, 1, native_text=lambda _p: True)
        self.assertNotIn("nativeTextLength", payload["pages"][0])

    def test_convert_range_projects_the_native_text_length_seam(self):
        converter = FakeConverter(FakeDoc(body=FakeGroup([FakeItem(text="x")])))
        payload = convert_range(
            "/tmp/a.pdf",
            1,
            1,
            lambda: converter,
            native_text=lambda _p: True,
            native_text_length=lambda _p: 55,
        )
        self.assertEqual(payload["pages"][0]["nativeTextLength"], 55)

    def test_run_range_emits_native_text_length_from_its_factory(self):
        doc = FakeDoc(body=FakeGroup([FakeItem(text="ok")]))
        stdout = io.StringIO()
        code = run_range(
            "/tmp/a.pdf",
            1,
            2,
            lambda: FakeConverter(doc),
            lambda _p: (lambda page: True),
            stdout,
            io.StringIO(),
            length_prober_factory=lambda _path: (lambda page: 100 + page),
        )
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(
            [p["nativeTextLength"] for p in json.loads(stdout.getvalue())["pages"]], [101, 102]
        )

    def test_run_range_omits_native_text_length_without_a_factory(self):
        doc = FakeDoc(body=FakeGroup([FakeItem(text="ok")]))
        stdout = io.StringIO()
        run_range(
            "/tmp/a.pdf",
            1,
            1,
            lambda: FakeConverter(doc),
            lambda _p: (lambda page: True),
            stdout,
            io.StringIO(),
        )
        self.assertNotIn("nativeTextLength", json.loads(stdout.getvalue())["pages"][0])


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

    def __init__(self, *, peak=None, fail_on=None, fail_on_release=False):
        self.calls = []
        self.info = {
            "BasicLimitInformation": {"LimitFlags": 0},
            "ProcessMemoryLimit": 0,
            "JobMemoryLimit": 0,
            "PeakJobMemoryUsed": peak,
        }
        self._fail_on = fail_on
        self._fail_on_release = fail_on_release
        self._assigned = False

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
        # `fail_on_release` fails only the reconfigure that follows assignment, so a job that applied
        # cleanly can still fail to release (#843).
        if self._fail_on == "set" or (self._fail_on_release and self._assigned):
            raise OSError("SetInformationJobObject failed")
        self.info = info

    def assign_current_process(self, _job):
        self.calls.append("assign")
        if self._fail_on == "assign":
            raise OSError("AssignProcessToJobObject failed")
        self._assigned = True


class _RecordingBoundary:
    """A ``MemoryBoundary`` double that records apply/release, so ``main``'s exit paths can be asserted.

    The Job Object fake above is the right instrument for the FLAG semantics; this one is the right
    instrument for "release ran exactly once on this return path, and could not change the code" (#843).
    """

    def __init__(self, *, apply_error=None, release_error=None, peak=None):
        self.applied = []
        self.releases = 0
        self._apply_error = apply_error
        self._release_error = release_error
        self._peak = peak

    def apply(self, limit_bytes):
        self.applied.append(limit_bytes)
        if self._apply_error is not None:
            raise self._apply_error

    def peak_bytes(self):
        return self._peak

    def release(self):
        self.releases += 1
        if self._release_error is not None:
            raise self._release_error


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


class MemoryBoundaryReleaseTests(unittest.TestCase):
    """#843: the orderly-exit release that stops the boundary overwriting the code the worker chose."""

    UNRELATED_FLAG = 0x400  # e.g. DIE_ON_UNHANDLED_EXCEPTION set by an outer job; must survive both calls.

    def test_windows_release_clears_only_the_kill_on_job_close_flag(self):
        api = _FakeWin32JobApi(peak=7 * 1024 * 1024)
        api.info["BasicLimitInformation"]["LimitFlags"] = self.UNRELATED_FLAG
        boundary = _WindowsMemoryBoundary(api)
        apply_memory_limit("128", boundary)
        applied_flags = api.info["BasicLimitInformation"]["LimitFlags"]

        boundary.release()

        # Exactly the KILL_ON_JOB_CLOSE bit is dropped — nothing else is touched, added or reset.
        self.assertEqual(
            api.info["BasicLimitInformation"]["LimitFlags"],
            applied_flags & ~api.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        )
        self.assertFalse(
            api.info["BasicLimitInformation"]["LimitFlags"] & api.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        # The MEMORY ceiling is NOT released with it: both flags and both limits stand.
        self.assertTrue(
            api.info["BasicLimitInformation"]["LimitFlags"] & api.JOB_OBJECT_LIMIT_PROCESS_MEMORY
        )
        self.assertTrue(
            api.info["BasicLimitInformation"]["LimitFlags"] & api.JOB_OBJECT_LIMIT_JOB_MEMORY
        )
        self.assertTrue(api.info["BasicLimitInformation"]["LimitFlags"] & self.UNRELATED_FLAG)
        self.assertEqual(api.info["ProcessMemoryLimit"], 128 * 1024 * 1024)
        self.assertEqual(api.info["JobMemoryLimit"], 128 * 1024 * 1024)
        # One reconfigure, and the handle is kept open so the metrics sidecar can still read the peak.
        self.assertEqual(api.calls, ["create", "query", "set", "assign", "query", "set"])
        self.assertEqual(boundary.peak_bytes(), 7 * 1024 * 1024)

    def test_windows_release_without_an_applied_job_touches_nothing(self):
        # A ceiling that was never requested leaves no job, so the exit-path release is a no-op — it must
        # not create or configure one just to tear it down.
        api = _FakeWin32JobApi()
        _WindowsMemoryBoundary(api).release()
        self.assertEqual(api.calls, [])

    def test_posix_release_is_a_noop(self):
        # RLIMIT_AS dies with the process and can never overwrite the exit status, so POSIX stands nothing
        # down — and in particular does not touch the rlimit it set.
        recorder = types.SimpleNamespace(calls=[], RLIMIT_AS="AS")
        recorder.setrlimit = lambda which, pair: recorder.calls.append((which, pair))
        boundary = _PosixMemoryBoundary(recorder)
        apply_memory_limit("256", boundary)
        boundary.release()
        self.assertEqual(recorder.calls, [("AS", (256 * 1024 * 1024, 256 * 1024 * 1024))])

    def test_releasing_no_boundary_is_a_noop(self):
        release_memory_boundary(None)  # must not raise

    def test_a_failing_release_is_swallowed(self):
        # Best effort: a cleanup must never become a new failure mode on top of the outcome being reported.
        boundary = _WindowsMemoryBoundary(_FakeWin32JobApi(fail_on_release=True))
        apply_memory_limit("64", boundary)
        release_memory_boundary(boundary)  # must not raise
        boundary = _RecordingBoundary(release_error=RuntimeError("handle gone"))
        release_memory_boundary(boundary)  # must not raise
        self.assertEqual(boundary.releases, 1)


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



# --- Conversion completeness (#832: a degraded docling result is never a payload) --------------


class FakeConversionStatus(str, enum.Enum):
    """Stands in for docling's ``ConversionStatus`` (also a ``str`` enum) with the members we branch on."""

    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"
    FAILURE = "failure"


class FakeError:
    """One docling ``ErrorItem``: the page it failed on and the converter's own message."""

    def __init__(self, page_no=None, error_message="std::bad_alloc"):
        self.page_no = page_no
        self.error_message = error_message


class FakeStatusConverter:
    """A converter whose result reports a status, errors, and its per-page processing record.

    ``processed_pages`` defaults to a complete record — one entry per requested page, as a healthy run
    produces — so a test that means to exercise the STATUS gate is not accidentally refused by the
    per-page one (#840). Pass it explicitly to model a converter that under-produced.
    """

    def __init__(self, doc, status, errors=(), processed_pages=None):
        self._doc = doc
        self._status = status
        self._errors = list(errors)
        self._processed_pages = processed_pages
        self.calls = []

    def convert(self, pdf_path, page_range=None):
        self.calls.append((pdf_path, page_range))
        return types.SimpleNamespace(
            document=self._doc,
            status=self._status,
            errors=self._errors,
            pages=page_evidence(page_range, self._processed_pages),
        )


@contextlib.contextmanager
def fake_docling_conversion_status():
    """Install a fake ``docling.datamodel.base_models`` exposing ``ConversionStatus``.

    Mirrors how the build_converter test mocks docling: no real models, no network, and the lazy import
    inside ``load_conversion_status`` resolves to the fake enum.
    """
    docling = types.ModuleType("docling")
    datamodel = types.ModuleType("docling.datamodel")
    base_models = types.ModuleType("docling.datamodel.base_models")
    base_models.ConversionStatus = FakeConversionStatus
    docling.datamodel = datamodel
    datamodel.base_models = base_models
    modules = {
        "docling": docling,
        "docling.datamodel": datamodel,
        "docling.datamodel.base_models": base_models,
    }
    saved = {name: sys.modules.get(name) for name in modules}
    sys.modules.update(modules)
    try:
        yield
    finally:
        for name, prior in saved.items():
            if prior is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prior


_MODULE_CONVERSION_STATUS = None


def setUpModule():
    """Install the fake ``ConversionStatus`` for the whole module, as its header promises.

    Every fake converter here now reports a status, because the completeness gate fails closed. The
    lazy ``load_conversion_status`` import must therefore resolve for ordinary range tests too — and it
    resolves to the fake, never to a real docling install, so these stay pure unit tests. Tests that
    care about the import itself still enter ``fake_docling_conversion_status`` explicitly.
    """
    global _MODULE_CONVERSION_STATUS
    _MODULE_CONVERSION_STATUS = fake_docling_conversion_status()
    _MODULE_CONVERSION_STATUS.__enter__()


def tearDownModule():
    _MODULE_CONVERSION_STATUS.__exit__(None, None, None)


class ConversionCompletenessTests(unittest.TestCase):
    def test_load_conversion_status_imports_the_docling_enum_lazily(self):
        with fake_docling_conversion_status():
            self.assertIs(load_conversion_status(), FakeConversionStatus)

    def test_a_result_reporting_no_status_is_refused(self):
        # FAIL CLOSED (D8). This gate is the only completeness guard, so its one permissive seam is
        # closed: a converter that cannot report its own status makes a claim we cannot check, and an
        # unverifiable conversion is not a complete one. No docling import is needed to reach this.
        with self.assertRaises(ConversionIncomplete) as caught:
            ensure_conversion_complete(types.SimpleNamespace(document=FakeDoc()))
        self.assertEqual(caught.exception.status, "unreported")
        self.assertEqual(caught.exception.failed_pages, [])
        self.assertIn("no conversion status", caught.exception.reason)

    def test_an_explicitly_null_status_is_refused(self):
        with self.assertRaises(ConversionIncomplete) as caught:
            ensure_conversion_complete(types.SimpleNamespace(document=FakeDoc(), status=None))
        self.assertEqual(caught.exception.status, "unreported")

    def test_success_is_accepted(self):
        with fake_docling_conversion_status():
            ensure_conversion_complete(
                types.SimpleNamespace(status=FakeConversionStatus.SUCCESS, errors=[])
            )

    def test_partial_success_is_refused_with_its_failed_pages_and_reason(self):
        errors = [
            FakeError(page_no=159, error_message="std::bad_alloc"),
            FakeError(page_no=160, error_message="std::bad_alloc"),
            FakeError(page_no=159, error_message="std::bad_alloc"),
        ]
        with fake_docling_conversion_status():
            with self.assertRaises(ConversionIncomplete) as caught:
                ensure_conversion_complete(
                    types.SimpleNamespace(
                        status=FakeConversionStatus.PARTIAL_SUCCESS, errors=errors
                    )
                )
        # Distinct pages, ascending; docling's own message quoted once.
        self.assertEqual(caught.exception.failed_pages, [159, 160])
        self.assertEqual(caught.exception.reason, "std::bad_alloc")
        self.assertIn("PARTIAL_SUCCESS", caught.exception.status)
        self.assertIn("2 page(s) failed to convert", str(caught.exception))

    def test_failure_is_refused(self):
        with fake_docling_conversion_status():
            with self.assertRaises(ConversionIncomplete) as caught:
                ensure_conversion_complete(
                    types.SimpleNamespace(
                        status=FakeConversionStatus.FAILURE, errors=[FakeError(page_no=4)]
                    )
                )
        self.assertIn("FAILURE", caught.exception.status)
        self.assertEqual(caught.exception.failed_pages, [4])

    def test_a_refusal_without_error_detail_still_names_the_status(self):
        with fake_docling_conversion_status():
            with self.assertRaises(ConversionIncomplete) as caught:
                ensure_conversion_complete(
                    types.SimpleNamespace(status=FakeConversionStatus.FAILURE, errors=None)
                )
        self.assertEqual(caught.exception.failed_pages, [])
        self.assertIn("no error detail", caught.exception.reason)

    def test_unusable_page_numbers_are_ignored_rather_than_reported_as_pages(self):
        # A missing page_no, a null one, and a bool (which is an int in Python) are not page numbers.
        with fake_docling_conversion_status():
            with self.assertRaises(ConversionIncomplete) as caught:
                ensure_conversion_complete(
                    types.SimpleNamespace(
                        status=FakeConversionStatus.PARTIAL_SUCCESS,
                        errors=[
                            types.SimpleNamespace(error_message="no page attribute at all"),
                            FakeError(page_no=None),
                            FakeError(page_no=True),
                            FakeError(page_no=7),
                        ],
                    )
                )
        self.assertEqual(caught.exception.failed_pages, [7])

    def test_the_quoted_reason_is_bounded(self):
        errors = [FakeError(page_no=page, error_message=f"e{page}") for page in range(1, 8)]
        with fake_docling_conversion_status():
            with self.assertRaises(ConversionIncomplete) as caught:
                ensure_conversion_complete(
                    types.SimpleNamespace(
                        status=FakeConversionStatus.PARTIAL_SUCCESS, errors=errors
                    )
                )
        reason = caught.exception.reason
        self.assertEqual(reason.count(";"), MAX_REPORTED_CONVERSION_ERRORS)
        self.assertIn(f"and {7 - MAX_REPORTED_CONVERSION_ERRORS} more", reason)
        self.assertNotIn("e7", reason)

    def test_convert_range_builds_no_payload_from_a_degraded_conversion(self):
        converter = FakeStatusConverter(
            FakeDoc(body=FakeGroup([FakeItem(text="the one page that survived")])),
            FakeConversionStatus.PARTIAL_SUCCESS,
            [FakeError(page_no=2)],
        )
        with fake_docling_conversion_status():
            with self.assertRaises(ConversionIncomplete):
                convert_range("/tmp/a.pdf", 1, 3, lambda: converter, native_text=lambda _p: True)

    def test_convert_range_accepts_a_success_status(self):
        converter = FakeStatusConverter(
            FakeDoc(body=FakeGroup([FakeItem(text="x")])), FakeConversionStatus.SUCCESS
        )
        with fake_docling_conversion_status():
            payload = convert_range(
                "/tmp/a.pdf", 1, 2, lambda: converter, native_text=lambda _p: True
            )
        self.assertEqual(payload["body"][0]["text"], "x")
        self.assertEqual(converter.calls, [("/tmp/a.pdf", (1, 2))])

    def test_run_range_classifies_an_incomplete_conversion_and_emits_no_payload(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        converter = FakeStatusConverter(
            FakeDoc(body=FakeGroup([FakeItem(text="fragment")])),
            FakeConversionStatus.PARTIAL_SUCCESS,
            [FakeError(page_no=159, error_message="std::bad_alloc")],
        )
        with fake_docling_conversion_status():
            code = run_range(
                "/tmp/a.pdf",
                151,
                200,
                lambda: converter,
                native_text_factory(lambda _p: True),
                stdout,
                stderr,
            )
        self.assertEqual(code, EXIT_CONVERSION_INCOMPLETE)
        self.assertEqual(stdout.getvalue(), "")
        message = stderr.getvalue()
        self.assertIn("pages 151-200", message)
        self.assertIn("PARTIAL_SUCCESS", message)
        self.assertIn("1 failed page(s) [159]", message)
        self.assertIn("std::bad_alloc", message)

    def test_run_range_bounds_the_reported_page_list(self):
        stderr = io.StringIO()
        failed = list(range(1, MAX_REPORTED_FAILED_PAGES + 4))
        converter = FakeStatusConverter(
            FakeDoc(),
            FakeConversionStatus.PARTIAL_SUCCESS,
            [FakeError(page_no=page) for page in failed],
        )
        with fake_docling_conversion_status():
            code = run_range(
                "/tmp/a.pdf",
                1,
                50,
                lambda: converter,
                native_text_factory(lambda _p: True),
                io.StringIO(),
                stderr,
            )
        self.assertEqual(code, EXIT_CONVERSION_INCOMPLETE)
        message = stderr.getvalue()
        self.assertIn(f"{len(failed)} failed page(s)", message)
        self.assertIn("and 3 more", message)
        self.assertNotIn(str(MAX_REPORTED_FAILED_PAGES + 1), message.split("]")[0])

    def test_run_range_reports_an_unreported_page_list_as_such(self):
        stderr = io.StringIO()
        converter = FakeStatusConverter(FakeDoc(), FakeConversionStatus.FAILURE, [FakeError()])
        with fake_docling_conversion_status():
            code = run_range(
                "/tmp/a.pdf",
                1,
                2,
                lambda: converter,
                native_text_factory(lambda _p: True),
                io.StringIO(),
                stderr,
            )
        self.assertEqual(code, EXIT_CONVERSION_INCOMPLETE)
        self.assertIn("[not reported]", stderr.getvalue())


# --- Per-page processing evidence (#840: the backstop behind the status gate) -------------------

# The real 35-character notice pages 25 and 29 of the 462-page Clean Code PDF both carry, byte for
# byte, on identically sized pages with an identical text bounding box. In the SAME converter run page
# 29 produced one item and page 25 produced none, which is why an item count is not completeness
# evidence (docs/DECISIONS.md D8) — and why the page-25 case is pinned here with the real string.
BLANK_PAGE_NOTICE = "This page intentionally left blank "


class PageProcessingEvidenceTests(unittest.TestCase):
    """Completeness is checked against the pages the range REQUESTED (#840).

    ``ConversionResult.pages`` carries one entry per page the converter actually processed. Measured on
    the real book: a healthy 10-page range produced ten entries (``page_no`` 21..30), and the reproduced
    #843 degradation produced 6 entries for 50 requested pages whose 44 absentees matched docling's own
    error records element for element — the record and the reported status AGREE there, because pinned
    docling derives the status from this very list. They part where the converter narrows the window
    itself, which the status cannot see. So the signal is set equality — the page numbers present must
    be the page numbers requested — and a page is refused for being ABSENT, never for producing nothing.
    """

    def test_the_per_page_record_yields_the_pages_the_converter_processed(self):
        result = types.SimpleNamespace(pages=page_evidence((21, 23)))
        self.assertEqual(processed_page_numbers(result), {21, 22, 23})

    def test_a_result_carrying_no_per_page_record_proves_nothing(self):
        # FAIL CLOSED: no record at all is not "nothing went wrong", it is no evidence, so every
        # requested page is unproven and the range is refused rather than published.
        self.assertEqual(processed_page_numbers(types.SimpleNamespace()), set())
        self.assertEqual(processed_page_numbers(types.SimpleNamespace(pages=None)), set())
        with self.assertRaises(ConversionIncomplete) as caught:
            ensure_pages_processed(types.SimpleNamespace(pages=None), 4, 6)
        self.assertEqual(caught.exception.failed_pages, [4, 5, 6])

    def test_an_unusable_page_number_is_not_evidence(self):
        # A missing page_no, a null one, a bool (an int in Python), and a non-positive one are not page
        # numbers, so those entries prove nothing — the same shape rule the error records get.
        result = types.SimpleNamespace(
            pages=[
                types.SimpleNamespace(predictions="PagePredictions"),
                FakePage(None),
                FakePage(True),
                FakePage(0),
                FakePage(2),
            ]
        )
        self.assertEqual(processed_page_numbers(result), {2})

    def test_a_complete_record_passes_the_gate(self):
        # THE case that must not regress: a healthy range is accepted. A gate that refuses everything
        # would fail every PDF import, which is worse than no gate at all.
        ensure_pages_processed(
            types.SimpleNamespace(status=FakeConversionStatus.SUCCESS, pages=page_evidence((21, 30))),
            21,
            30,
        )

    def test_released_per_page_state_is_still_processing_evidence(self):
        # Docling releases per-page state after assembly: `parsed_page` is None on every successfully
        # converted page, measured across all ten pages of a healthy range. Presence of the entry is the
        # evidence; gating on state the converter is free to release would refuse every healthy book.
        released = FakePage(21, predictions=None, assembled=None)
        self.assertIsNone(released.parsed_page)
        ensure_pages_processed(types.SimpleNamespace(pages=[released]), 21, 21)

    def test_the_reproduced_fragment_shape_is_refused_even_when_the_status_claims_success(self):
        # A converter that reports an unqualified SUCCESS while its own record shows it processed 6 of
        # 50 requested pages. This is not hypothetical: asked for pages 461-470 of the real 462-page
        # book, docling clamps the window to 461-462 and reports SUCCESS with zero errors, so the status
        # gate sees nothing wrong and only a check against the REQUESTED window refuses.
        result = types.SimpleNamespace(
            status=FakeConversionStatus.SUCCESS,
            errors=[],
            pages=page_evidence(None, [21, 22, 23, 24, 25, 26]),
        )
        with self.assertRaises(ConversionIncomplete) as caught:
            ensure_pages_processed(result, 21, 70)
        self.assertEqual(caught.exception.failed_pages, list(range(27, 71)))
        self.assertIn("SUCCESS", caught.exception.status)
        self.assertIn("covers 6 of 50 requested page(s)", caught.exception.reason)
        self.assertIn("44 page(s) carry no processing evidence", caught.exception.reason)
        self.assertIn("44 page(s) failed to convert", str(caught.exception))

    def test_evidence_outside_the_window_cannot_stand_in_for_a_missing_page(self):
        # Only the REQUESTED pages count. A record padded with repeats and with pages from another
        # range must not mask page 23, or the gate could be satisfied by evidence about other work.
        result = types.SimpleNamespace(pages=page_evidence(None, [21, 21, 22, 99]))
        with self.assertRaises(ConversionIncomplete) as caught:
            ensure_pages_processed(result, 21, 23)
        self.assertEqual(caught.exception.failed_pages, [23])
        self.assertIn("covers 2 of 3 requested page(s)", caught.exception.reason)

    def test_a_result_with_no_status_names_the_missing_status_in_its_refusal(self):
        with self.assertRaises(ConversionIncomplete) as caught:
            ensure_pages_processed(types.SimpleNamespace(pages=page_evidence(None, [1])), 1, 2)
        self.assertEqual(caught.exception.status, "unreported")
        self.assertEqual(caught.exception.failed_pages, [2])

    def test_a_processed_page_that_produced_no_item_is_not_refused(self):
        # D8's page 25, with the real string: pages 25 and 29 carry byte-identical native text, and in
        # the same run page 29 produced one item while page 25 produced none of any kind. Both were
        # processed, so both carry evidence and the range converts. Refusing here would reject every
        # book with a numbered blank page — 15 of this one's 462 pages carry that notice.
        doc = FakeDoc(
            body=FakeGroup([FakeItem(text=BLANK_PAGE_NOTICE, prov=FakeProv(page_no=29))])
        )
        converter = FakeStatusConverter(doc, FakeConversionStatus.SUCCESS)
        with fake_docling_conversion_status():
            payload = convert_range(
                "/tmp/clean-code.pdf", 25, 29, lambda: converter, native_text=lambda _p: True
            )
        self.assertEqual([page["pageNumber"] for page in payload["pages"]], [25, 26, 27, 28, 29])
        self.assertEqual(
            [(item["pageNumber"], item["text"]) for item in payload["body"]],
            [(29, BLANK_PAGE_NOTICE)],
        )

    def test_convert_range_builds_no_payload_from_a_short_per_page_record(self):
        converter = FakeStatusConverter(
            FakeDoc(body=FakeGroup([FakeItem(text="the pages that survived")])),
            FakeConversionStatus.SUCCESS,
            processed_pages=[1, 2],
        )
        with fake_docling_conversion_status():
            with self.assertRaises(ConversionIncomplete) as caught:
                convert_range("/tmp/a.pdf", 1, 3, lambda: converter, native_text=lambda _p: True)
        self.assertEqual(caught.exception.failed_pages, [3])

    def test_convert_range_accepts_a_complete_per_page_record(self):
        converter = FakeStatusConverter(
            FakeDoc(body=FakeGroup([FakeItem(text="x", prov=FakeProv(page_no=2))])),
            FakeConversionStatus.SUCCESS,
        )
        with fake_docling_conversion_status():
            payload = convert_range(
                "/tmp/a.pdf", 1, 3, lambda: converter, native_text=lambda _p: True
            )
        self.assertEqual([page["pageNumber"] for page in payload["pages"]], [1, 2, 3])
        self.assertEqual(payload["body"][0]["text"], "x")

    def test_run_range_reports_lost_pages_with_the_incomplete_exit_code(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        converter = FakeStatusConverter(
            FakeDoc(body=FakeGroup([FakeItem(text="fragment")])),
            FakeConversionStatus.SUCCESS,
            processed_pages=[21, 22, 23, 24, 25, 26],
        )
        with fake_docling_conversion_status():
            code = run_range(
                "/tmp/a.pdf",
                21,
                70,
                lambda: converter,
                native_text_factory(lambda _p: True),
                stdout,
                stderr,
            )
        self.assertEqual(code, EXIT_CONVERSION_INCOMPLETE)
        self.assertEqual(stdout.getvalue(), "")
        message = stderr.getvalue()
        self.assertIn("pages 21-70", message)
        self.assertIn("44 failed page(s)", message)
        self.assertIn("[27, 28,", message)
        self.assertIn("no processing evidence", message)


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
            outline_reader_factory=lambda _path: (
                lambda: [{"title": "Chapter 1", "level": 0, "pageIndex": 0}]
            ),
            length_prober_factory=lambda _path: (lambda page: 30 if page == 1 else 0),
            boundary=None,
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual([p["hasNativeText"] for p in payload["pages"]], [True, False])
        self.assertEqual(payload["metadata"], {"title": "Doc", "author": "Ada"})
        self.assertEqual(
            payload["outline"], [{"title": "Chapter 1", "level": 1, "pageNumber": 1}]
        )
        self.assertEqual([p["nativeTextLength"] for p in payload["pages"]], [30, 0])

    def test_default_length_prober_factory_is_wired_for_range_mode_when_not_injected(self):
        # Exercise the branch that builds the default native-text-length factory from the opener, so a
        # range payload reports each page's own whitespace-stripped character count without an injected
        # factory (#817) — the only production path that calls the real get_text_range() backend method.
        doc = FakeDoc(body=FakeGroup([FakeItem(text="ok")]))
        stdout = io.StringIO()
        code = main(
            ["--range", "/tmp/a.pdf", "1", "1"],
            converter_factory=lambda: FakeConverter(doc),
            opener=lambda _p: FakeBackendDoc(1, page=FakeBackendPage(text="ab  cd\tef")),
            metadata_reader_factory=lambda _path: (lambda: {}),
            boundary=None,
            stdout=stdout,
            stderr=io.StringIO(),
        )
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["pages"][0]["nativeTextLength"], len("abcdef"))

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

    # --- #843: the boundary is stood down on EVERY return path, and can never change the code ---------

    def _main_with(self, boundary, argv, ceiling="512", **kwargs):
        """Run ``main`` with the memory-ceiling env var set, so the injected boundary is really applied."""
        previous = os.environ.get(MEMORY_LIMIT_ENV)
        os.environ[MEMORY_LIMIT_ENV] = ceiling
        try:
            return main(
                argv, boundary=boundary, stdout=io.StringIO(), stderr=io.StringIO(), **kwargs
            )
        finally:
            if previous is None:
                os.environ.pop(MEMORY_LIMIT_ENV, None)
            else:
                os.environ[MEMORY_LIMIT_ENV] = previous

    def test_a_successful_run_releases_the_boundary_exactly_once(self):
        boundary = _RecordingBoundary()
        code = self._main_with(boundary, ["--probe", "/tmp/a.pdf"], opener=lambda _p: FakeBackendDoc(1))
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(boundary.applied, [512 * 1024 * 1024])
        self.assertEqual(boundary.releases, 1)

    def test_every_return_path_releases_the_boundary(self):
        # The early readiness-probe return, the unenforceable-ceiling return and BOTH usage returns are
        # exactly the paths a `return` inside the ceiling's scope would skip.
        for name, argv, boundary, expected in (
            (
                "readiness probe",
                ["--check-memory-ceiling"],
                _RecordingBoundary(),
                EXIT_OK,
            ),
            (
                "unenforceable ceiling",
                ["--probe", "/tmp/a.pdf"],
                _RecordingBoundary(apply_error=MemoryCeilingUnsupported(512)),
                EXIT_MEMORY_CEILING_UNSUPPORTED,
            ),
            ("unknown mode", ["--nope"], _RecordingBoundary(), EXIT_USAGE),
            ("bad page range", ["--range", "/tmp/a.pdf", "5", "2"], _RecordingBoundary(), EXIT_USAGE),
        ):
            with self.subTest(name):
                code = self._main_with(boundary, argv, opener=lambda _p: FakeBackendDoc(1))
                self.assertEqual(code, expected)
                self.assertEqual(boundary.releases, 1)

    def test_a_raising_release_never_changes_the_code_the_worker_decided(self):
        # The release is a best-effort cleanup on the way out; if it fails, the worker still reports the
        # outcome it classified rather than inventing a new failure.
        for name, argv, expected in (
            ("success", ["--probe", "/tmp/a.pdf"], EXIT_OK),
            ("usage error", ["--nope"], EXIT_USAGE),
        ):
            with self.subTest(name):
                boundary = _RecordingBoundary(release_error=OSError("SetInformationJobObject failed"))
                code = self._main_with(boundary, argv, opener=lambda _p: FakeBackendDoc(1))
                self.assertEqual(code, expected)
                self.assertEqual(boundary.releases, 1)

    def test_a_propagating_exception_still_releases_the_boundary(self):
        # A MemoryError raised while emitting the payload travels PAST `main` to `_entrypoint`, which
        # turns it into EXIT_MEMORY (7) — one of the codes the ceiling was destroying. That is why the
        # stand-down lives in a `finally` rather than on each `return`.
        boundary = _RecordingBoundary()

        class _RaisingStdout:
            def write(self, _text):
                raise MemoryError("the payload does not fit under the ceiling")

        previous = os.environ.get(MEMORY_LIMIT_ENV)
        os.environ[MEMORY_LIMIT_ENV] = "512"
        try:
            with self.assertRaises(MemoryError):
                main(
                    ["--probe", "/tmp/a.pdf"],
                    opener=lambda _p: FakeBackendDoc(1),
                    boundary=boundary,
                    stdout=_RaisingStdout(),
                    stderr=io.StringIO(),
                )
        finally:
            if previous is None:
                os.environ.pop(MEMORY_LIMIT_ENV, None)
            else:
                os.environ[MEMORY_LIMIT_ENV] = previous
        self.assertEqual(boundary.releases, 1)

    def test_the_peak_is_read_before_the_boundary_is_released(self):
        # The release deliberately keeps the job handle open, but the sidecar is still written first, so
        # peak accounting never depends on what release does.
        api = _FakeWin32JobApi(peak=3 * 1024 * 1024)
        boundary = _WindowsMemoryBoundary(api)
        observed = []
        code = self._main_with(
            boundary,
            ["--probe", "/tmp/a.pdf"],
            opener=lambda _p: FakeBackendDoc(1),
            metrics_writer=lambda _path, b: observed.append(b.peak_bytes()),
        )
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(observed, [3 * 1024 * 1024])
        self.assertFalse(
            api.info["BasicLimitInformation"]["LimitFlags"] & api.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        # The handle outlives the release, so the peak is still readable afterwards.
        self.assertEqual(boundary.peak_bytes(), 3 * 1024 * 1024)


@unittest.skipUnless(sys.platform == "win32", "Windows Job Object enforcement is Windows-only")
class WindowsMemoryCeilingEnforcementTests(unittest.TestCase):
    """REAL child-process contract tests for the Windows Job Object boundary (#782, #843).

    A fake can prove which Job Object calls fired; only a real process can prove what the OS then does.
    These spawn a real interpreter under a real ceiling to check the two things that matter: an
    over-ceiling allocation actually fails (#782), and the ceiling does not overwrite the exit code the
    worker chose on its way out (#843). Where pywin32 is unavailable each falls back to asserting the
    typed unsupported result.
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

    def test_an_applied_ceiling_does_not_overwrite_the_exit_code(self):
        # #843, and the ONLY instrument that can see it: no fake can observe the Job Object killing this
        # process at interpreter shutdown, which is exactly why the defect survived every unit test. The
        # child applies the REAL ceiling through the REAL boundary, releases it, and exits 9 — the
        # `conversion_incomplete` code #832 added. Before the release existed this process exited 0.
        script = (
            "import sys\n"
            "from pdf_to_docling import (resolve_memory_boundary, apply_memory_limit, "
            "release_memory_boundary, MemoryCeilingUnsupported)\n"
            "boundary = resolve_memory_boundary('win32')\n"
            "if boundary is None:\n"
            "    print('UNSUPPORTED'); sys.exit(8)\n"
            "try:\n"
            "    apply_memory_limit('512', boundary)\n"
            "except MemoryCeilingUnsupported:\n"
            "    print('UNSUPPORTED'); sys.exit(8)\n"
            "release_memory_boundary(boundary)\n"
            "print('APPLIED')\n"
            "sys.stdout.flush()\n"
            "sys.exit(9)\n"
        )
        result = self._run_child(script)
        if result.stdout.strip() == "UNSUPPORTED":
            self.assertEqual(result.returncode, 8)
            return
        self.assertEqual(
            result.returncode,
            9,
            msg="the ceiling destroyed the worker's exit code: the process chose 9 and reported "
            f"{result.returncode} (stdout={result.stdout!r} stderr={result.stderr!r})",
        )
        self.assertEqual(result.stdout.strip(), "APPLIED", msg=result.stderr)

    def test_main_reports_its_own_exit_code_through_a_real_ceiling(self):
        # The same proof one level up, over the production entry point: with the ceiling env var the
        # server always sets, a usage return must still reach the parent as 2 rather than a silent 0.
        script = (
            "import io, os, sys\n"
            "os.environ['WHETSTONE_PDF_MEMORY_MIB'] = '512'\n"
            "from pdf_to_docling import main\n"
            "code = main(['--nope'], stdout=io.StringIO(), stderr=io.StringIO())\n"
            "print(f'MAIN_RETURNED={code}')\n"
            "sys.stdout.flush()\n"
            "sys.exit(code)\n"
        )
        result = self._run_child(script)
        if "MAIN_RETURNED=8" in result.stdout:  # pywin32 absent: the ceiling is refused, not applied.
            self.assertEqual(result.returncode, 8)
            return
        self.assertEqual(
            result.returncode,
            2,
            msg="main chose a usage exit but the process reported "
            f"{result.returncode}: the memory boundary overwrote it "
            f"(stdout={result.stdout!r} stderr={result.stderr!r})",
        )
        self.assertIn("MAIN_RETURNED=2", result.stdout, msg=result.stderr)


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
                outline_reader_factory=lambda _path: (lambda: []),
                length_prober_factory=lambda _path: (lambda page: 0),
                boundary=None,
                stdout=stdout,
                stderr=io.StringIO(),
            )
            self.assertEqual(code, EXIT_OK)
            payload = json.loads(stdout.getvalue())
            # The default image reader seam calls item.get_image(doc), which the fake picture exposes.
            self.assertEqual(payload["body"][0]["imageArtifact"]["path"], "fig-0.png")
            self.assertEqual(os.listdir(directory), ["fig-0.png"])


class ExitCodeWireContractTests(unittest.TestCase):
    """The worker's exit codes are a cross-LANGUAGE wire contract, not a private enum.

    ``pdf_to_docling.py`` calls ``sys.exit(EXIT_*)`` and the TypeScript adapter's ``classifyWorkerExit``
    (``src/apps/server/src/files/pdfStructuredErrors.ts``) switches on those same integers to decide
    which ``PdfStructuredFailure`` an import reports -- so a refused, incomplete conversion (exit 9) is
    told apart from a malformed file (exit 4), an encrypted PDF (exit 5), a missing toolchain (exit 3),
    and so on. The two sides are different languages, so no shared constant can bind them: the integers
    themselves ARE the contract, mirrored by ``WORKER_EXIT_*`` on the TypeScript side.

    Every other test in this suite compares an outcome against the ``EXIT_*`` *symbol*, so renumbering
    the integer a symbol carries keeps the whole suite green while silently breaking classification --
    the exact gap mutation testing surfaced in the #839 review, and the same class of defect #843/#844
    fixed (a Windows Job Object was collapsing these very codes to 0, so a refused conversion was read
    as a malformed one). This test pins the literal integers so a change fails loudly here and forces
    the matching, deliberate edit to ``WORKER_EXIT_*`` on the TypeScript side.
    """

    def test_exit_codes_match_their_pinned_wire_integers(self):
        # Codes 3-9 are the failures the worker self-classifies and the adapter branches on; 0 is
        # success and 2 is a usage error. To change one, change the matching WORKER_EXIT_* in
        # pdfStructuredErrors.ts in the SAME commit and then update this pin -- never renumber "to tidy
        # up", because these integers cross the process boundary on the wire.
        self.assertEqual(
            {
                "EXIT_OK": EXIT_OK,
                "EXIT_USAGE": EXIT_USAGE,
                "EXIT_MISSING_DEPENDENCY": EXIT_MISSING_DEPENDENCY,
                "EXIT_CONVERSION_FAILED": EXIT_CONVERSION_FAILED,
                "EXIT_PASSWORD_REQUIRED": EXIT_PASSWORD_REQUIRED,
                "EXIT_UNSUPPORTED_SCHEMA": EXIT_UNSUPPORTED_SCHEMA,
                "EXIT_MEMORY": EXIT_MEMORY,
                "EXIT_MEMORY_CEILING_UNSUPPORTED": EXIT_MEMORY_CEILING_UNSUPPORTED,
                "EXIT_CONVERSION_INCOMPLETE": EXIT_CONVERSION_INCOMPLETE,
            },
            {
                "EXIT_OK": 0,
                "EXIT_USAGE": 2,
                "EXIT_MISSING_DEPENDENCY": 3,
                "EXIT_CONVERSION_FAILED": 4,
                "EXIT_PASSWORD_REQUIRED": 5,
                "EXIT_UNSUPPORTED_SCHEMA": 6,
                "EXIT_MEMORY": 7,
                "EXIT_MEMORY_CEILING_UNSUPPORTED": 8,
                "EXIT_CONVERSION_INCOMPLETE": 9,
            },
            msg=(
                "PDF worker exit-code WIRE CONTRACT drift: a worker exit code no longer carries its "
                "pinned integer. These values are shared verbatim with WORKER_EXIT_* in "
                "src/apps/server/src/files/pdfStructuredErrors.ts, where classifyWorkerExit maps each "
                "integer to an import failure. Change BOTH sides in the same commit, or the adapter "
                "will misclassify a real worker outcome (e.g. read a refused, incomplete conversion as "
                "a malformed file). Codes 3-9 are the self-classified failures; 0=success, 2=usage."
            ),
        )

    def test_no_exit_code_is_left_unpinned(self):
        # Totality guard for the pin above: that pin lists a FIXED set of names, so a newly added EXIT_*
        # (e.g. EXIT_SOMETHING = 10, with its WORKER_EXIT_SOMETHING on the TypeScript side) would cross
        # the wire while no test asserts its integer -- reopening the exact gap this class closes.
        # Enumerate the module's EXIT_* integer constants at runtime and require the pinned set to stay
        # complete; a new one must be added to the pin above and mirrored by WORKER_EXIT_*.
        exit_constant_names = {
            name
            for name, value in vars(pdf_to_docling).items()
            if name.startswith("EXIT_") and isinstance(value, int)
        }
        self.assertEqual(
            exit_constant_names,
            {
                "EXIT_OK",
                "EXIT_USAGE",
                "EXIT_MISSING_DEPENDENCY",
                "EXIT_CONVERSION_FAILED",
                "EXIT_PASSWORD_REQUIRED",
                "EXIT_UNSUPPORTED_SCHEMA",
                "EXIT_MEMORY",
                "EXIT_MEMORY_CEILING_UNSUPPORTED",
                "EXIT_CONVERSION_INCOMPLETE",
            },
            msg=(
                "A worker EXIT_* constant in pdf_to_docling.py is not pinned to its integer by "
                "test_exit_codes_match_their_pinned_wire_integers above. Every exit code crosses the "
                "process boundary to WORKER_EXIT_* in pdfStructuredErrors.ts, so add the new code to "
                "that pin and mirror it on the TypeScript side -- an unpinned wire code is the exact "
                "gap #842 closes."
            ),
        )


if __name__ == "__main__":
    unittest.main()
