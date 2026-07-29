"""Pure text-similarity metrics for voice calibration — normalized Chinese CER and English WER.

Kept dependency-free (stdlib only) and side-effect-free so the accuracy math is unit-tested directly and
runs anywhere. `calibrate.py` composes these over a local manifest; nothing here reads files, spawns a
process, or prints — and it never retains the raw text beyond the returned counts.
"""
from __future__ import annotations

import unicodedata
from typing import Dict, Iterable, List, Sequence

# Unicode categories dropped before scoring so surface punctuation/spacing differences never inflate the
# error rate: P* = punctuation, S* = symbols, Z* = separators (spaces), C* = control/format.
_IGNORED_CATEGORY_PREFIXES = ("P", "S", "Z", "C")


def _is_scored(char: str) -> bool:
    return not unicodedata.category(char).startswith(_IGNORED_CATEGORY_PREFIXES)


def normalize_chars(text: str) -> List[str]:
    """Normalize for CER: NFKC-fold, drop punctuation/symbols/spaces, return the scored characters.

    NFKC folds full-width/compatibility forms so visually identical CJK/Latin compare equal; whitespace
    and punctuation are removed because Chinese ASR references carry none of the model's spacing choices.
    """
    folded = unicodedata.normalize("NFKC", text)
    return [char for char in folded if _is_scored(char)]


def normalize_tokens(text: str) -> List[str]:
    """Normalize for WER: NFKC-fold, lowercase, strip punctuation to spaces, split into word tokens."""
    folded = unicodedata.normalize("NFKC", text).lower()
    cleaned = "".join(char if _is_scored(char) else " " for char in folded)
    return cleaned.split()


def edit_distance(reference: Sequence[str], hypothesis: Sequence[str]) -> int:
    """Levenshtein distance between two token/char sequences (insert/delete/substitute cost 1)."""
    previous = list(range(len(hypothesis) + 1))
    for i, ref_item in enumerate(reference, start=1):
        current = [i]
        for j, hyp_item in enumerate(hypothesis, start=1):
            cost = 0 if ref_item == hyp_item else 1
            current.append(
                min(
                    previous[j] + 1,  # deletion
                    current[j - 1] + 1,  # insertion
                    previous[j - 1] + cost,  # substitution
                )
            )
        previous = current
    return previous[-1]


def score_clip(reference: str, hypothesis: str, kind: str) -> Dict[str, int]:
    """Count edits and reference length for one clip, using CER units (zh) or WER units (en/other).

    Returns only integer counts — never the text — so an aggregate can be built without ever holding or
    printing private transcript/reference content.
    """
    ref = normalize_chars(reference) if kind == "zh" else normalize_tokens(reference)
    hyp = normalize_chars(hypothesis) if kind == "zh" else normalize_tokens(hypothesis)
    return {"edits": edit_distance(ref, hyp), "reference_units": len(ref)}


def _rate(edits: int, reference_units: int) -> float:
    # An empty reference with any hypothesis output is a full miss (rate 1.0); an empty-vs-empty pair is
    # a perfect 0.0. This keeps a degenerate clip from dividing by zero or silently scoring 0.
    if reference_units == 0:
        return 0.0 if edits == 0 else 1.0
    return edits / reference_units


def clip_rate(reference: str, hypothesis: str, kind: str) -> float:
    """The error rate (CER or WER) for a single clip as a fraction in [0, 1]."""
    counts = score_clip(reference, hypothesis, kind)
    return _rate(counts["edits"], counts["reference_units"])


def micro_rate(counts: Iterable[Dict[str, int]]) -> float:
    """The micro-averaged error rate: total edits over total reference units across the given clips."""
    total_edits = 0
    total_units = 0
    for entry in counts:
        total_edits += entry["edits"]
        total_units += entry["reference_units"]
    return _rate(total_edits, total_units)
