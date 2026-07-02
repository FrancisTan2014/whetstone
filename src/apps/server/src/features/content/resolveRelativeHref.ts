// Resolve an EPUB cross-file reference to the source-file identity it targets, so a footnote/endnote
// marker in one chapter can be scoped to the chapter that owns its target (#366). Pure and POSIX-only
// (EPUB hrefs are always `/`-separated), so it is deterministic across platforms and unit-testable
// without the filesystem.
//
// `baseSourceFile` is the marker's own source file (an EPUB spine href like `text/ch01.xhtml`);
// `refFile` is the file part of the marker's href (`../notes.xhtml`), or null when the marker points
// within its own file. A null `refFile` — or an href with only a query/fragment and no path — resolves
// to the base file. Otherwise `refFile` is resolved relative to the base file's directory, normalizing
// `.` and `..` segments and stripping any `?query`/`#fragment`, yielding a path comparable to another
// unit's spine href.
export function resolveRelativeHref(
  baseSourceFile: string | null,
  refFile: string | null
): string | null {
  if (refFile === null) {
    return baseSourceFile;
  }

  const path = refFile.split(/[?#]/)[0] as string;

  if (path === "") {
    return baseSourceFile;
  }

  // An absolute ref starts from the root; a relative ref starts from the base file's directory.
  const segments = path.startsWith("/")
    ? []
    : baseSourceFile === null
      ? []
      : baseSourceFile.split("/").slice(0, -1);

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}
