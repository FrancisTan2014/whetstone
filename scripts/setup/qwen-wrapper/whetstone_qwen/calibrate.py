"""Provider-neutral voice calibration — measure accuracy, cold latency, and peak memory locally.

`python -m whetstone_qwen.calibrate --binary <LOCAL_ASR_BINARY> --model <LOCAL_ASR_MODEL>
--manifest <manifest.json>` runs any protocol-honouring local speech executable over a **local** clip
manifest and reports aggregate metrics: micro-averaged Chinese CER, English WER, the worst single-clip
CER, the worst cold (fresh-process) transcription duration, and peak process RSS. It is provider-neutral
because it drives the executable through the same `--model … --output json <audio>` contract the server
uses, so it calibrates Qwen3-ASR or any replacement without change.

Privacy is a hard rule: the audio, its reference text, and the produced transcript never leave the
machine and are **never printed** — only the aggregate numbers are emitted. That lets a maintainer run
the gate and paste the result into a PR without exposing any private diary content. The clip manifest and
all referenced audio/reference files are read from local paths only; nothing is copied or uploaded.

The subprocess spawn + peak-RSS measurement is the un-fakeable OS boundary (`_default_runner`); the
manifest parsing, scoring, aggregation, and gate are pure and unit-tested with a fake runner.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Callable, Dict, List, Optional, Sequence

from . import metrics

_GIB = 1024**3

# The acceptance gate (issue #800): the maintained clear modern/classical Mandarin set must micro-average
# <= 3% CER with no clip above 5%; a cold capture must transcribe in <= 90 s and peak process RSS must
# stay <= 10 GiB on the reference host. English WER is reported for evidence but not gated here.
DEFAULT_THRESHOLDS = {
    "micro_cer": 0.03,
    "max_clip_cer": 0.05,
    "cold_duration_s": 90.0,
    "peak_rss_gib": 10.0,
}

# A per-clip transcription measurement returned by a runner. Deliberately carries NO transcript/reference
# text — only the accuracy counts and resource numbers — so an aggregate can be built and printed without
# ever holding private content.
RunnerResult = Dict[str, Any]
Runner = Callable[[str, str, str], "TranscriptMeasurement"]


class TranscriptMeasurement:
    """What a runner reports for one clip: the transcript (used only to score, never printed) plus the
    cold duration and peak RSS of the fresh process."""

    def __init__(self, transcript: str, duration_s: float, peak_rss_bytes: int) -> None:
        self.transcript = transcript
        self.duration_s = duration_s
        self.peak_rss_bytes = peak_rss_bytes


def load_manifest(path: str) -> List[Dict[str, str]]:
    """Read the local clip manifest: `{"clips": [{"audio", "reference", "lang"}]}` (or a bare list).

    `lang` defaults to `zh` (CER units); any non-`zh` clip is scored as WER. Each clip needs an `audio`
    path and a `reference` transcript. Raises a clear ValueError on a malformed entry rather than
    silently skipping a clip (which would flatter the metrics).
    """
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    clips = raw["clips"] if isinstance(raw, dict) else raw
    if not isinstance(clips, list) or len(clips) == 0:
        raise ValueError("manifest has no clips")
    parsed: List[Dict[str, str]] = []
    for entry in clips:
        if not isinstance(entry, dict) or "audio" not in entry or "reference" not in entry:
            raise ValueError("each manifest clip needs an 'audio' path and a 'reference' transcript")
        parsed.append(
            {
                "audio": str(entry["audio"]),
                "reference": str(entry["reference"]),
                "lang": str(entry.get("lang", "zh")),
            }
        )
    return parsed


def measure_clips(clips: Sequence[Dict[str, str]], binary: str, model: str, runner: Runner) -> List[RunnerResult]:
    """Run each clip through the executable and score it, keeping only counts and resource numbers.

    The transcript returned by the runner is used solely to compute the edit counts here and is then
    dropped, so no private text is retained past scoring.
    """
    records: List[RunnerResult] = []
    for clip in clips:
        measurement = runner(binary, model, clip["audio"])
        kind = "zh" if clip["lang"] == "zh" else "en"
        counts = metrics.score_clip(clip["reference"], measurement.transcript, kind)
        records.append(
            {
                "kind": kind,
                "edits": counts["edits"],
                "reference_units": counts["reference_units"],
                "duration_s": float(measurement.duration_s),
                "peak_rss_bytes": int(measurement.peak_rss_bytes),
            }
        )
    return records


def aggregate(records: Sequence[RunnerResult]) -> Dict[str, Any]:
    """Reduce per-clip counts to the aggregate metrics — numbers only, no clip text or paths."""
    zh = [r for r in records if r["kind"] == "zh"]
    en = [r for r in records if r["kind"] == "en"]
    peak_rss_bytes = max((r["peak_rss_bytes"] for r in records), default=0)
    return {
        "clips": len(records),
        "zh_clips": len(zh),
        "en_clips": len(en),
        "micro_cer": metrics.micro_rate(zh),
        "max_clip_cer": max((metrics._rate(r["edits"], r["reference_units"]) for r in zh), default=0.0),
        "wer": metrics.micro_rate(en),
        "cold_duration_s": max((r["duration_s"] for r in records), default=0.0),
        "peak_rss_bytes": peak_rss_bytes,
        "peak_rss_gib": peak_rss_bytes / _GIB,
    }


def evaluate(summary: Dict[str, Any], thresholds: Dict[str, float]) -> Dict[str, Any]:
    """Compare the aggregate against the gate thresholds, returning per-check and overall pass booleans."""
    checks = {
        "micro_cer": summary["micro_cer"] <= thresholds["micro_cer"],
        "max_clip_cer": summary["max_clip_cer"] <= thresholds["max_clip_cer"],
        "cold_duration_s": summary["cold_duration_s"] <= thresholds["cold_duration_s"],
        "peak_rss_gib": summary["peak_rss_gib"] <= thresholds["peak_rss_gib"],
    }
    return {"checks": checks, "pass": all(checks.values()), "thresholds": dict(thresholds)}


def build_report(records: Sequence[RunnerResult], thresholds: Dict[str, float]) -> Dict[str, Any]:
    """The full aggregate report (metrics + gate verdict). Contains only numbers and booleans."""
    summary = aggregate(records)
    summary["gate"] = evaluate(summary, thresholds)
    return summary


def _default_runner(binary: str, model: str, audio: str) -> TranscriptMeasurement:  # pragma: no cover - OS boundary
    """Spawn the executable fresh (cold) on one clip and measure wall time + peak child RSS (POSIX)."""
    import resource
    import subprocess
    import time

    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    started = time.monotonic()
    completed = subprocess.run(
        [binary, "--model", model, "--output", "json", audio],
        capture_output=True,
        text=True,
        check=True,
    )
    duration = time.monotonic() - started
    after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    # ru_maxrss is kilobytes on Linux and bytes on macOS; normalize the delta to bytes on Linux.
    delta = max(after - before, 0)
    peak_rss_bytes = delta * 1024 if sys.platform.startswith("linux") else delta
    transcript = json.loads(completed.stdout).get("text", "")
    return TranscriptMeasurement(transcript=transcript, duration_s=duration, peak_rss_bytes=peak_rss_bytes)


def main(argv: Optional[Sequence[str]] = None, runner: Runner = _default_runner) -> int:
    parser = argparse.ArgumentParser(prog="whetstone-qwen-calibrate")
    parser.add_argument("--binary", required=True, help="the LOCAL_ASR executable to calibrate")
    parser.add_argument("--model", required=True, help="the model identifier passed to the executable")
    parser.add_argument("--manifest", required=True, help="path to the local clip manifest JSON")
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))

    clips = load_manifest(args.manifest)
    records = measure_clips(clips, args.binary, args.model, runner)
    report = build_report(records, DEFAULT_THRESHOLDS)
    # Aggregate numbers only — never any audio path, reference, or transcript.
    sys.stdout.write(json.dumps(report, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0 if report["gate"]["pass"] else 1


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())
