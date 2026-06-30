import {
  type JSONNodeType,
  type NodeProps,
  renderJSONContentToReactElement
} from "@tiptap/static-renderer/json/react";
import type { DocumentNodeJSON } from "@whetstone/document";

import { calloutKindClass, headingTag } from "./PmDocument.tokens";

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
type PmNodeProps = NodeProps<PmNode, React.ReactNode | React.ReactNode[]>;
type PmNodeRenderer = (props: PmNodeProps) => React.ReactNode;

function stringAttr(node: PmNode, key: string): string | undefined {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttr(node: PmNode, key: string): number | undefined {
  const value = node.attrs?.[key];
  return typeof value === "number" ? value : undefined;
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

const nodeMapping: Record<string, PmNodeRenderer> = {
  blockquote: ({ children, node, parent }) => (
    <blockquote {...topLevelBlockAttrs(node, parent)}>{children}</blockquote>
  ),
  bulletList: ({ children, node, parent }) => (
    <ul {...topLevelBlockAttrs(node, parent)}>{children}</ul>
  ),
  callout: ({ children, node, parent }) => {
    const kind = stringAttr(node, "kind");
    const marker = stringAttr(node, "marker") ?? numberAttr(node, "marker");
    const modifier = calloutKindClass(kind);
    const className = modifier === undefined ? "readerCallout" : `readerCallout ${modifier}`;

    return (
      <aside
        className={className}
        {...(kind === undefined ? {} : { "data-callout-kind": kind })}
        {...topLevelBlockAttrs(node, parent)}
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
      <pre {...topLevelBlockAttrs(node, parent)}>
        <code {...(language === undefined ? {} : { "data-language": language })}>{children}</code>
      </pre>
    );
  },
  definitionDescription: ({ children }) => <dd>{children}</dd>,
  definitionList: ({ children, node, parent }) => (
    <dl {...topLevelBlockAttrs(node, parent)}>{children}</dl>
  ),
  definitionTerm: ({ children }) => <dt>{children}</dt>,
  doc: ({ children }) => <div className="reader pmDocument">{children}</div>,
  figure: ({ children, node, parent }) => (
    <figure className="readerFigure" {...topLevelBlockAttrs(node, parent)}>
      {children}
    </figure>
  ),
  // The image is display-only and never fetched in v0 (mirrors the mdast reader, which dropped
  // `<img>`): an inert placeholder exposes the alt text but issues no network request, and the
  // figure's caption carries the readable content.
  figureCaption: ({ children }) => (
    <figcaption className="readerFigureCaption">{children}</figcaption>
  ),
  footnoteMarker: ({ node }) => {
    const label = stringAttr(node, "label");
    const refId = stringAttr(node, "refId");

    return (
      <sup
        className="readerNoteref"
        {...(refId === undefined ? {} : { "data-footnote-ref": refId })}
      >
        {label ?? refId ?? ""}
      </sup>
    );
  },
  footnoteTarget: ({ children, node, parent }) => {
    const label = stringAttr(node, "label");
    const refId = stringAttr(node, "refId");

    return (
      <aside
        className="readerFootnoteTarget"
        {...(refId === undefined ? {} : { "data-footnote-id": refId })}
        {...topLevelBlockAttrs(node, parent)}
      >
        {label === undefined ? null : <span className="readerFootnoteLabel">{label}</span>}
        {children}
      </aside>
    );
  },
  heading: ({ children, node, parent }) => {
    const Tag = headingTag(numberAttr(node, "level"));
    return <Tag {...topLevelBlockAttrs(node, parent)}>{children}</Tag>;
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
        {...topLevelBlockAttrs(node, parent)}
        {...(start === undefined || start === 1 ? {} : { start })}
      >
        {children}
      </ol>
    );
  },
  paragraph: ({ children, node, parent }) => (
    <p {...topLevelBlockAttrs(node, parent)}>{children}</p>
  ),
  table: ({ children, node, parent }) => (
    <table {...topLevelBlockAttrs(node, parent)}>
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
    <pre className="readerUnknown" data-pm-unknown="" {...topLevelBlockAttrs(node, parent)}>
      {stringAttr(node, "html") ?? ""}
    </pre>
  )
};

const renderDocument = renderJSONContentToReactElement({ markMapping: {}, nodeMapping });

export interface PmDocumentProps {
  readonly document: DocumentNodeJSON;
}

// Render a stored PM document to React. The doc root carries the `.reader` class so the existing
// reader typography and Day/Night theme tokens (CSS variables on an ancestor) style the output with
// no per-theme component logic.
export function PmDocument({ document }: PmDocumentProps): React.ReactElement {
  // `DocumentNodeJSON` and the renderer's `JSONNodeType` are the same on-the-wire PM JSON; one
  // structural cast at the boundary lets the typed node handlers above drive the render.
  const content = document as unknown as JSONNodeType;
  return <>{renderDocument({ content })}</>;
}

export interface PmBlockProps {
  readonly node: DocumentNodeJSON;
}

// Render a single stored PM block node (not the whole doc) to React, reusing the same per-node
// mapping. The live reader memoizes one of these per block (#72) and stamps the addressable
// `data-block-id` on its own wrapper element, so the block's own element stays unaddressed here
// (`topLevelBlockAttrs` only addresses a child of a `doc`, and this node has no `doc` parent).
export function PmBlock({ node }: PmBlockProps): React.ReactElement {
  const content = node as unknown as JSONNodeType;
  return <>{renderDocument({ content })}</>;
}
