import {
  type JSONMarkType,
  type JSONNodeType,
  type MarkProps,
  type NodeProps,
  renderJSONContentToReactElement
} from "@tiptap/static-renderer/json/react";
import type { DocumentNodeJSON } from "@whetstone/document";
import { createContext, useContext, useMemo } from "react";

import { calloutKindClass, headingTag } from "./PmDocument.tokens";
import { stripFlankingFootnoteBrackets } from "./pmFootnotes";

// Read-only renderer for a stored whetstone PM/Tiptap document (the #310 `@whetstone/document`
// schema), built on `@tiptap/static-renderer` (MIT, no browser/editor). The #310 node specs carry no
// `renderHTML`/`toDOM`, so this module supplies an explicit React mapping for every node type. It is
// the eventual replacement for the mdast→hast `BlockContent` renderer; the live ReaderPage swap and
// annotation decorations are the next slice (#313). Read-only here — no editing, no link navigation.
//
// Safety: no node uses `dangerouslySetInnerHTML`. The `unknown` fallback prints its preserved raw
// HTML as inert text (React's default text escaping turns `<el>` into `&lt;el&gt;`, so it is shown,
// never parsed or executed — the same fail-loud-but-safe stance as the mdast path that dropped raw
// HTML). The package's `escapeHTML` is deliberately not used here: feeding an already-escaped string
// to a React text child would double-escape it.

type PmNode = JSONNodeType;
type PmMark = JSONMarkType;
type PmNodeProps = NodeProps<PmNode, React.ReactNode | React.ReactNode[]>;
type PmNodeRenderer = (props: PmNodeProps) => React.ReactNode;

function stringAttr(node: PmNode, key: string): string | undefined {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : undefined;
}

function markStringAttr(mark: PmMark, key: string): string | undefined {
  const value = mark.attrs?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttr(node: PmNode, key: string): number | undefined {
  const value = node.attrs?.[key];
  return typeof value === "number" ? value : undefined;
}

// The reader's block-jump, threaded to the module-level node mapping through context because
// `@tiptap/static-renderer` builds its mapping once at module scope (#335). A footnote marker consumes
// it to become a live internal jump; absent (a raw render with no reader wiring), markers stay inert.
// The optional second argument is the reference's target source file (#366): a footnote marker passes
// its `targetSourceFile` so an endnote in a separate file resolves against that file, not the unit the
// reader is in. Callers that omit it (an in-file marker, the mdast/#252 path) resolve same-file.
const ActivateAnchorContext = createContext<
  ((anchor: string, targetSourceFile?: string) => void) | undefined
>(undefined);

// Whether a same-work reference's (targetSourceFile, anchor) has a live target in the work anchor
// index (#550). Threaded like `ActivateAnchorContext` because the renderer builds its mapping at
// module scope. A footnote marker / link mark consults it to render INERT when its target cannot be
// resolved — never a live-but-dead control. Absent (a raw render with no reader wiring) leaves the
// gate open so a bare `<PmDocument>` keeps rendering markers as before.
const CanResolveContext = createContext<
  ((anchor: string, targetSourceFile?: string) => boolean) | undefined
>(undefined);

// A footnote/endnote reference marker. With a `refId`, the reader's jump wired, AND a resolvable
// target (#550), it renders an accent-styled, keyboard-focusable superscript control that
// scrolls+highlights its footnote target (reusing `onActivateAnchor`, the same block-jump the mdast
// path uses); the target's own back-link returns here via the derived `${refId}-ref` anchor stamped on
// the control. Without a resolvable `refId`, a jump handler, or a target that resolves in the index, it
// is a clean, non-interactive superscript number — no dead button.
function FootnoteMarker({ node }: { node: PmNode }): React.ReactElement {
  const label = stringAttr(node, "label");
  const refId = stringAttr(node, "refId");
  // The file the marker points into (#366), computed at ingest by resolving the marker's href against
  // its chapter. Passed to the resolver so a cross-file endnote lands in the right unit; absent for an
  // in-file reference, which resolves against the current unit.
  const targetSourceFile = stringAttr(node, "targetSourceFile");
  const onActivateAnchor = useContext(ActivateAnchorContext);
  const canResolve = useContext(CanResolveContext);
  const text = label ?? refId ?? "";
  const resolvable =
    refId !== undefined && (canResolve === undefined || canResolve(refId, targetSourceFile));

  if (refId === undefined || onActivateAnchor === undefined || !resolvable) {
    return (
      <sup
        className="readerNoteref"
        {...(refId === undefined ? {} : { "data-footnote-ref": refId })}
      >
        {text}
      </sup>
    );
  }

  return (
    <sup className="readerNoteref" data-footnote-ref={refId}>
      <button
        className="readerXref"
        data-anchor-id={`${refId}-ref`}
        onClick={() => onActivateAnchor(refId, targetSourceFile)}
        type="button"
      >
        {text}
      </button>
    </sup>
  );
}

// A same-work reference link mark (#368). It keeps its text IN the paragraph's inline run (a mark, not
// an atom) so CJK inter-character spacing is preserved (`见周髀之术`, #340/#358). With a resolvable
// `anchor`, the reader's jump wired, AND a live target in the index (#550), it renders a focusable
// inline control that scrolls+highlights its target via `onActivateAnchor` — the SAME work-scoped
// resolution the footnote/endnote markers use (#366), threading the mark's `targetSourceFile` so a
// cross-chapter reference lands in the right unit. An INERT link (external/cross-work), a link with no
// anchor, a raw render with no jump wired, OR a same-work link whose target does not resolve stays
// styled but non-navigating text: a `<span>`, never a live `<a href>` that could hijack the SPA route.
function LinkMark({
  children,
  mark
}: {
  children?: React.ReactNode;
  mark: PmMark;
}): React.ReactElement {
  const anchor = markStringAttr(mark, "anchor");
  const targetSourceFile = markStringAttr(mark, "targetSourceFile");
  const inert = mark.attrs?.["inert"] === true;
  const onActivateAnchor = useContext(ActivateAnchorContext);
  const canResolve = useContext(CanResolveContext);
  const resolvable =
    anchor !== undefined && (canResolve === undefined || canResolve(anchor, targetSourceFile));

  if (inert || anchor === undefined || onActivateAnchor === undefined || !resolvable) {
    return <span className="readerLink readerLink--inert">{children}</span>;
  }

  return (
    <button
      className="readerLink readerXref"
      onClick={() => onActivateAnchor(anchor, targetSourceFile)}
      type="button"
    >
      {children}
    </button>
  );
}

// Addressable id: only a top-level block (its parent is the `doc`) carries `data-block-id`, so
// notes/position/search can anchor to it. Nested nodes stay unaddressed (their top-level block owns
// the address). The id is the stable #310 UniqueID stamped by `assignNodeIds`.
function topLevelBlockAttrs(
  node: PmNode,
  parent: PmNode | undefined
): { "data-block-id"?: string } {
  if (parent?.type !== "doc") {
    return {};
  }

  const id = stringAttr(node, "id");
  return id === undefined ? {} : { "data-block-id": id };
}

// The map from a block's stable PM node ids to the source-HTML anchor each id-bearing element carries
// (#550), threaded to the renderer so it can stamp `data-anchor-id` onto the PRECISE nested element —
// not just the top-level block — for element-precise cross-reference jumps.
export type AnchorByNodeId = ReadonlyMap<string, string>;

// Element-precise anchor stamp: when this node's stable id is one the block's anchor map knows, stamp
// its source-HTML anchor as `data-anchor-id` so a cross-reference resolving to this element scrolls to
// it exactly. Applies at any depth (a nested heading/figure/anchor), unlike `data-block-id` which only
// addresses the top-level block. Kept as a render-time DOM attribute; the stored node JSON stays pure.
function anchorIdAttrs(
  node: PmNode,
  anchorByNodeId: AnchorByNodeId
): { "data-anchor-id"?: string } {
  const id = stringAttr(node, "id");

  if (id === undefined) {
    return {};
  }

  const anchor = anchorByNodeId.get(id);
  return anchor === undefined ? {} : { "data-anchor-id": anchor };
}

// Build the per-node React mapping, closing over the block's anchor map so every block-level renderer
// stamps both its addressable `data-block-id` (top-level only) and, at any depth, the element-precise
// `data-anchor-id` (#550). Rebuilt per render from a stable map, so memoized blocks do not churn.
function createNodeMapping(anchorByNodeId: AnchorByNodeId): Record<string, PmNodeRenderer> {
  // The combined block attributes: the addressable top-level id plus the element-precise anchor stamp.
  const blockAttrs = (
    node: PmNode,
    parent: PmNode | undefined
  ): { "data-anchor-id"?: string; "data-block-id"?: string } => ({
    ...topLevelBlockAttrs(node, parent),
    ...anchorIdAttrs(node, anchorByNodeId)
  });

  return {
    blockquote: ({ children, node, parent }) => (
      <blockquote {...blockAttrs(node, parent)}>{children}</blockquote>
    ),
    bulletList: ({ children, node, parent }) => <ul {...blockAttrs(node, parent)}>{children}</ul>,
    callout: ({ children, node, parent }) => {
      const kind = stringAttr(node, "kind");
      const marker = stringAttr(node, "marker") ?? numberAttr(node, "marker");
      const modifier = calloutKindClass(kind);
      const className = modifier === undefined ? "readerCallout" : `readerCallout ${modifier}`;

      return (
        <aside
          className={className}
          {...(kind === undefined ? {} : { "data-callout-kind": kind })}
          {...blockAttrs(node, parent)}
        >
          {marker === undefined ? null : (
            <span className="readerCalloutMarker">{String(marker)}</span>
          )}
          {children}
        </aside>
      );
    },
    codeBlock: ({ children, node, parent }) => {
      const language = stringAttr(node, "language");

      return (
        <pre {...blockAttrs(node, parent)}>
          <code {...(language === undefined ? {} : { "data-language": language })}>{children}</code>
        </pre>
      );
    },
    definitionDescription: ({ children }) => <dd>{children}</dd>,
    definitionList: ({ children, node, parent }) => (
      <dl {...blockAttrs(node, parent)}>{children}</dl>
    ),
    definitionTerm: ({ children }) => <dt>{children}</dt>,
    doc: ({ children }) => <div className="reader pmDocument">{children}</div>,
    figure: ({ children, node, parent }) => (
      <figure className="readerFigure" {...blockAttrs(node, parent)}>
        {children}
      </figure>
    ),
    // The image is display-only and never fetched in v0 (mirrors the mdast reader, which dropped
    // `<img>`): an inert placeholder exposes the alt text but issues no network request, and the
    // figure's caption carries the readable content.
    figureCaption: ({ children }) => (
      <figcaption className="readerFigureCaption">{children}</figcaption>
    ),
    footnoteMarker: ({ node }) => <FootnoteMarker node={node} />,
    footnoteTarget: ({ children, node, parent }) => {
      const label = stringAttr(node, "label");
      const refId = stringAttr(node, "refId");

      return (
        <aside
          className="readerFootnoteTarget"
          {...(refId === undefined ? {} : { "data-footnote-id": refId })}
          {...blockAttrs(node, parent)}
        >
          {label === undefined ? null : <span className="readerFootnoteLabel">{label}</span>}
          {children}
        </aside>
      );
    },
    heading: ({ children, node, parent }) => {
      const Tag = headingTag(numberAttr(node, "level"));
      return <Tag {...blockAttrs(node, parent)}>{children}</Tag>;
    },
    image: ({ node }) => (
      <span
        aria-label={stringAttr(node, "alt") ?? ""}
        className="readerFigureImage"
        data-pm-image=""
        role="img"
      />
    ),
    listItem: ({ children }) => <li>{children}</li>,
    orderedList: ({ children, node, parent }) => {
      const start = numberAttr(node, "start");

      return (
        <ol
          {...blockAttrs(node, parent)}
          {...(start === undefined || start === 1 ? {} : { start })}
        >
          {children}
        </ol>
      );
    },
    paragraph: ({ children, node, parent }) => <p {...blockAttrs(node, parent)}>{children}</p>,
    table: ({ children, node, parent }) => (
      <table {...blockAttrs(node, parent)}>
        <tbody>{children}</tbody>
      </table>
    ),
    tableCell: ({ children, node }) => {
      const colSpan = numberAttr(node, "colspan");
      const rowSpan = numberAttr(node, "rowspan");

      return (
        <td
          {...(colSpan === undefined ? {} : { colSpan })}
          {...(rowSpan === undefined ? {} : { rowSpan })}
        >
          {children}
        </td>
      );
    },
    tableHeader: ({ children, node }) => {
      const colSpan = numberAttr(node, "colspan");
      const rowSpan = numberAttr(node, "rowspan");

      return (
        <th
          scope="col"
          {...(colSpan === undefined ? {} : { colSpan })}
          {...(rowSpan === undefined ? {} : { rowSpan })}
        >
          {children}
        </th>
      );
    },
    tableRow: ({ children }) => <tr>{children}</tr>,
    text: ({ node }) => node.text ?? null,
    unknown: ({ node, parent }) => (
      <pre className="readerUnknown" data-pm-unknown="" {...blockAttrs(node, parent)}>
        {stringAttr(node, "html") ?? ""}
      </pre>
    )
  };
}

const markMapping = {
  bold: ({ children }: MarkProps<PmMark, React.ReactNode, PmNode>) => <strong>{children}</strong>,
  code: ({ children }: MarkProps<PmMark, React.ReactNode, PmNode>) => <code>{children}</code>,
  italic: ({ children }: MarkProps<PmMark, React.ReactNode, PmNode>) => <em>{children}</em>,
  link: ({ children, mark }: MarkProps<PmMark, React.ReactNode, PmNode>) => (
    <LinkMark mark={mark}>{children}</LinkMark>
  )
};

// A stable empty anchor map for a raw render (no reader wiring): stamping simply never fires.
const emptyAnchorByNodeId: AnchorByNodeId = new Map();

export interface PmDocumentProps {
  readonly document: DocumentNodeJSON;
  // The reader's block-jump. When provided, footnote markers become live internal jumps; absent, a raw
  // render leaves them inert. Absent by default so a bare `<PmDocument>` stays presentation-only. The
  // optional second argument carries a reference's target source file for cross-file resolution (#366).
  readonly onActivateAnchor?: (anchor: string, targetSourceFile?: string) => void;
  // The block's PM-node-id → source-anchor map (#550). Element-precise `data-anchor-id` is stamped on
  // each id-bearing node it knows. Absent leaves nested elements unstamped (a raw render).
  readonly anchorByNodeId?: AnchorByNodeId;
  // The work-anchor-index resolvability gate (#550). When provided, a same-work link/marker whose
  // target does not resolve renders inert. Absent leaves the gate open (a raw render stays as before).
  readonly canResolve?: (anchor: string, targetSourceFile?: string) => boolean;
}

// Render a stored PM document to React. The doc root carries the `.reader` class so the existing
// reader typography and Day/Night theme tokens (CSS variables on an ancestor) style the output with
// no per-theme component logic. Flanking footnote brackets are stripped at render (#335).
export function PmDocument({
  anchorByNodeId,
  canResolve,
  document,
  onActivateAnchor
}: PmDocumentProps): React.ReactElement {
  // `DocumentNodeJSON` and the renderer's `JSONNodeType` are the same on-the-wire PM JSON; one
  // structural cast at the boundary lets the typed node handlers above drive the render.
  const content = stripFlankingFootnoteBrackets(document) as unknown as JSONNodeType;
  const anchors = anchorByNodeId ?? emptyAnchorByNodeId;
  const renderDocument = useMemo(
    () => renderJSONContentToReactElement({ markMapping, nodeMapping: createNodeMapping(anchors) }),
    [anchors]
  );
  return (
    <CanResolveContext.Provider value={canResolve}>
      <ActivateAnchorContext.Provider value={onActivateAnchor}>
        {renderDocument({ content })}
      </ActivateAnchorContext.Provider>
    </CanResolveContext.Provider>
  );
}

export interface PmBlockProps {
  readonly node: DocumentNodeJSON;
  readonly onActivateAnchor?: (anchor: string, targetSourceFile?: string) => void;
  readonly anchorByNodeId?: AnchorByNodeId;
  readonly canResolve?: (anchor: string, targetSourceFile?: string) => boolean;
}

// Render a single stored PM block node (not the whole doc) to React, reusing the same per-node
// mapping. The live reader memoizes one of these per block (#72) and stamps the addressable
// `data-block-id` on its own wrapper element, so the block's own element stays unaddressed here
// (`topLevelBlockAttrs` only addresses a child of a `doc`, and this node has no `doc` parent). The
// reader threads this block's `anchorByNodeId` so element-precise `data-anchor-id` lands on the exact
// nested node (#550). When it wires `onActivateAnchor`, an in-block footnote marker becomes a live
// jump (#335); `canResolve` renders a same-work reference inert when its target is dead.
export function PmBlock({
  anchorByNodeId,
  canResolve,
  node,
  onActivateAnchor
}: PmBlockProps): React.ReactElement {
  const content = stripFlankingFootnoteBrackets(node) as unknown as JSONNodeType;
  const anchors = anchorByNodeId ?? emptyAnchorByNodeId;
  const renderDocument = useMemo(
    () => renderJSONContentToReactElement({ markMapping, nodeMapping: createNodeMapping(anchors) }),
    [anchors]
  );
  return (
    <CanResolveContext.Provider value={canResolve}>
      <ActivateAnchorContext.Provider value={onActivateAnchor}>
        {renderDocument({ content })}
      </ActivateAnchorContext.Provider>
    </CanResolveContext.Provider>
  );
}
