import { describe, expect, it } from "vitest";

import { sanitizeSvg } from "./svgSanitizer.js";

describe("sanitizeSvg", () => {
  it("keeps benign shapes and inline refs", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it("strips scripts, event handlers, and external/script references", () => {
    const out = sanitizeSvg(
      '<svg onload="alert(1)"><script>alert(1)</script><foreignObject></foreignObject>' +
        '<image href="https://evil.test/x.png"/><a href="javascript:alert(1)">x</a>' +
        '<use xlink:href="//cdn.test/y.svg"/><rect/></svg>'
    );

    expect(out).toContain("<rect");
    expect(out).not.toMatch(/script/iu);
    expect(out).not.toContain("onload");
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("cdn.test");
  });

  it("removes DOCTYPE/ENTITY and xml-stylesheet preambles", () => {
    const out = sanitizeSvg(
      '<!DOCTYPE svg [<!ENTITY x "y">]><?xml-stylesheet href="evil.css"?><svg><rect/></svg>'
    );
    expect(out).not.toContain("DOCTYPE");
    expect(out).not.toContain("xml-stylesheet");
    expect(out).toContain("<rect");
  });

  it("keeps internal anchors and inline data refs", () => {
    const svg = '<svg><a href="#frag"/><image href="data:image/png;base64,AA"/><rect/></svg>';
    const out = sanitizeSvg(svg);
    expect(out).toContain('href="#frag"');
    expect(out).toContain("data:image/png;base64,AA");
  });

  it("strips refs that hide javascript:/external URLs behind character references", () => {
    const out = sanitizeSvg(
      '<svg><a href="java&#x73;cript:alert(1)">x</a>' +
        '<a href="javascript&colon;alert(2)">y</a>' +
        '<image href="&#x68;ttps://evil.test/x.png"/>' +
        '<image href="&#104;ttps://evil.test/y.png"/>' +
        '<a href="#frag&foo;tail">keep</a><rect/></svg>'
    );
    expect(out).toContain("<rect");
    expect(out).not.toMatch(/x73;cript|alert/iu);
    expect(out).not.toContain("evil.test");
    // An internal ref with an unknown named entity is preserved (not classified as external).
    expect(out).toContain("#frag&foo;tail");
  });
});
