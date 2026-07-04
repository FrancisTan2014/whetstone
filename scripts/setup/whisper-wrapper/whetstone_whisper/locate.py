"""Locate the pip-generated `whetstone-whisper` console-script launcher.

`pnpm setup:voice` runs `python -m whetstone_whisper.locate` and writes the printed path to
WHISPER_BINARY (the server's execFile runs it directly). Resolution is injectable so it is unit
-tested without depending on the host's PATH or Python layout.

Console scripts are not always on PATH. Microsoft Store Python installs them into a sandboxed
per-user Scripts dir that Store Python never adds to PATH, so a PATH-only lookup fails there even in
a brand-new terminal (issue #424). We therefore probe the interpreter's own Scripts directories —
both the default install scheme and the per-user scheme — in addition to PATH, and, when nothing is
found, report the per-user Scripts dir so the setup step can give an accurate remedy.
"""
from __future__ import annotations

import os
import shutil
import sys
import sysconfig

LAUNCHER = "whetstone-whisper"


def user_scripts_dir() -> str:
    """The per-user install scheme's Scripts dir — where Store Python and `pip install --user` place
    console scripts (and which Store Python never adds to PATH)."""
    return sysconfig.get_path("scripts", os.name + "_user")


def script_dirs() -> list[str]:
    """Interpreter Scripts directories to probe, default scheme first, de-duplicated."""
    dirs: list[str] = []
    for directory in (sysconfig.get_path("scripts"), user_scripts_dir()):
        if directory and directory not in dirs:
            dirs.append(directory)
    return dirs


def find_launcher(which=shutil.which, scripts_dirs=None, exists=os.path.exists) -> str:
    found = which(LAUNCHER)
    if found:
        return found
    directories = scripts_dirs if scripts_dirs is not None else script_dirs()
    for directory in directories:
        for suffix in ("", ".exe"):
            candidate = os.path.join(directory, LAUNCHER + suffix)
            if exists(candidate):
                return candidate
    return ""


def main(argv=None) -> int:
    launcher = find_launcher()
    sys.stdout.write(launcher)
    if not launcher:
        # Hand the setup step an accurate, Store-Python-aware remedy: the exact per-user Scripts dir
        # where pip put the launcher but which is not on PATH.
        sys.stderr.write(user_scripts_dir())
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
