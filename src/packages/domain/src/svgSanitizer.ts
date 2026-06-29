// SVG figures from EPUBs are untrusted markup, so before any SVG is stored or served we strip the
// parts that could run script or phone home: <script>/<foreignObject> elements, on* event-handler
// attributes, javascript: URIs, external (http/https/protocol-relative) references in href/src, and
// any DOCTYPE/ENTITY (XXE) or xml-stylesheet preamble. The result still renders as a static diagram
// inside an <img> (which already neutralizes script), but this defends store-and-serve in depth.

const dangerousElements = ["script", "foreignObject", "iframe", "use", "animate", "set", "handler"];

function stripElement(svg: string, tag: string): string {
  const paired = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "giu");
  const selfClosing = new RegExp(`<${tag}\\b[^>]*/>`, "giu");
  const orphanOpen = new RegExp(`<${tag}\\b[^>]*>`, "giu");
  return svg.replace(paired, "").replace(selfClosing, "").replace(orphanOpen, "");
}

export function sanitizeSvg(svg: string): string {
  let out = svg.replace(/<!DOCTYPE[\s\S]*?>/giu, "").replace(/<\?xml-stylesheet[\s\S]*?\?>/giu, "");

  for (const tag of dangerousElements) {
    out = stripElement(out, tag);
  }

  // Drop event-handler attributes (onload, onclick, …).
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, "");

  // Neutralize external/script references in href, xlink:href, and src — keep only inline/data refs.
  out = out.replace(
    /\s(?:xlink:href|href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu,
    (match, value: string) => {
      const url = value
        .replace(/^["']|["']$/gu, "")
        .trim()
        .toLowerCase();
      const external = /^(?:https?:|\/\/|javascript:|data:text\/html)/u.test(url);
      return external ? "" : match;
    }
  );

  return out;
}
