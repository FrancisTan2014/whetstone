"""Pre-fetch a faster-whisper model so `pnpm setup --voice` fails loud on a download problem.

`WhisperModel(model)` downloads the model to the local cache on construction (a size name like
`small` auto-downloads; a path is used as-is). Running this as a distinct step lets the setup runner
map a network/download failure to an actionable remedy instead of surfacing it later at first use.
The loader is injectable so the argument handling is unit-tested without a real download.
"""
from __future__ import annotations

import sys


def main(argv=None, model_loader=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        sys.stderr.write("usage: python -m whetstone_whisper.fetch <model>\n")
        return 2
    model = args[0]
    if model_loader is None:  # pragma: no cover - real download boundary, not unit-tested
        from faster_whisper import WhisperModel

        model_loader = WhisperModel
    model_loader(model)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
