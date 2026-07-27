"""A stand-in for the pre-#647 `whetstone-whisper` launcher, for process-level readiness tests.

This reproduces the *stale* wrapper the bug is about: it forwards `--language auto` to the model
literally (never mapping it to `None`), and it predates the `--contract-version` probe, so argparse
rejects that flag with a nonzero exit. Running it as a real subprocess lets the setup step's readiness
check prove it detects an incompatible launcher at the process boundary — not merely against a mocked
argument string. It never imports faster-whisper or loads a model; on a real transcribe call it prints a
recognizable marker so a test can confirm it forwarded the literal language.
"""
from __future__ import annotations

import argparse
import json
import sys


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="whetstone-whisper")
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--output", default="json")
    parser.add_argument("--word-timestamps", dest="word_timestamps", action="store_true")
    parser.add_argument("audio")
    # No --contract-version: argparse exits nonzero on the unknown flag, exactly as the old launcher did.
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    # The stale bug: the literal language string is forwarded, so `auto` would reach the model verbatim.
    json.dump({"text": "", "language": args.language, "segments": []}, sys.stdout)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
