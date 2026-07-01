"""Locate the pip-generated `whetstone-whisper` console-script launcher.

`pnpm setup --voice` runs `python -m whetstone_whisper.locate` and writes the printed path to
WHISPER_BINARY (the server's execFile runs it directly). Resolution is injectable so it is unit
-tested without depending on the host's PATH or Python layout.
"""
from __future__ import annotations

import os
import shutil
import sys
import sysconfig


def find_launcher(which=shutil.which, scripts_dir=None, exists=os.path.exists) -> str:
    found = which("whetstone-whisper")
    if found:
        return found
    directory = scripts_dir if scripts_dir is not None else sysconfig.get_path("scripts")
    for suffix in ("", ".exe"):
        candidate = os.path.join(directory, "whetstone-whisper" + suffix)
        if exists(candidate):
            return candidate
    return ""


def main(argv=None) -> int:
    sys.stdout.write(find_launcher())
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
