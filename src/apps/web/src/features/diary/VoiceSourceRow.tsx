import { useEffect, useState } from "react";

import type { DiaryEntryDto } from "@whetstone/contracts";

import { diaryEntryAudioUrl, fetchDiaryEntry } from "./diaryApi.js";

// The retained recording is the source evidence; the transcript and rich body are derived, correctable
// representations (#801). This compact row sits above the editor for a ready voice entry so the learner
// can audit the body against the original recording without leaving the editor: a native player for the
// retained audio, a collapsed read-only disclosure of the verbatim transcript, and the detected language.
// It is deliberately read-only — the editor below it is the only editable/saved correction target — and
// it never fabricates evidence: no recording reports `Recording unavailable`, and an absent language shows
// nothing rather than an empty placeholder.

// The detected capture language shown as a small chip. Only `en`/`zh` are supported (#647); any other
// stored value is shown verbatim so the UI never lies about what was detected.
function languageLabel(language: string): string {
  if (language === "en") {
    return "English";
  }
  if (language === "zh") {
    return "中文";
  }
  return language;
}

type FetchState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ entry: DiaryEntryDto; status: "loaded" }>
  | Readonly<{ status: "error" }>;

type VoiceSourceRowProps = Readonly<{ entryId: string }>;

export function VoiceSourceRow({ entryId }: VoiceSourceRowProps): React.JSX.Element | null {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // Whether the retained recording failed to load in the player (e.g. it was removed after the entry was
  // read). Distinct from `hasAudio === false`: this reflects a live playback failure, and either way the
  // row reports `Recording unavailable` truthfully rather than showing a dead player.
  const [audioBroken, setAudioBroken] = useState(false);

  useEffect(() => {
    let active = true;
    fetchDiaryEntry(entryId).then(
      (entry) => {
        if (active) {
          setState({ entry, status: "loaded" });
        }
      },
      () => {
        if (active) {
          setState({ status: "error" });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [entryId]);

  if (state.status === "loading") {
    return (
      <div className="rounded border border-border bg-surface px-3 py-2 text-sm text-text-muted">
        Loading the voice source…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        className="rounded border border-border bg-surface px-3 py-2 text-sm text-text-muted"
        role="status"
      >
        We couldn&apos;t load the voice source.
      </div>
    );
  }

  const { entry } = state;
  const recordingAvailable = entry.hasAudio && !audioBroken;

  return (
    <section
      aria-label="Voice source"
      className="flex flex-col gap-2 rounded border border-border bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text-muted">Voice source</span>
        {entry.language !== null ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted">
            {languageLabel(entry.language)}
          </span>
        ) : null}
      </div>

      {recordingAvailable ? (
        // The native player supplies play/pause, seek, elapsed/duration, and volume — no custom media
        // player (an explicit non-goal). `metadata` preload loads the duration without fetching the whole
        // clip up front.
        <audio
          aria-label="Original recording"
          className="min-h-[44px] w-full"
          controls
          onError={() => setAudioBroken(true)}
          preload="metadata"
          src={diaryEntryAudioUrl(entry.id)}
        />
      ) : (
        <p className="text-sm text-text-muted" role="status">
          Recording unavailable
        </p>
      )}

      <TranscriptDisclosure transcript={entry.transcript} />
    </section>
  );
}

// The retained transcript, collapsed by default behind an accessible native disclosure. It is read-only
// and preserves its original whitespace (`whitespace-pre-wrap`) so the learner audits the exact ASR text,
// never a reflowed version. A voice entry with no retained transcript shows nothing here.
function TranscriptDisclosure({
  transcript
}: Readonly<{ transcript: string | null }>): React.JSX.Element | null {
  if (transcript === null) {
    return null;
  }

  return (
    <details className="text-sm">
      <summary className="flex min-h-[44px] cursor-pointer items-center text-text-muted">
        Original transcript
      </summary>
      <p aria-label="Original transcript" className="mt-1 whitespace-pre-wrap text-text">
        {transcript}
      </p>
    </details>
  );
}
