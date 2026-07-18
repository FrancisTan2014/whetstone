import { useState } from "react";
import { Link } from "react-router-dom";

import { Button, buttonVariants } from "../../shared/ui/Button";
import { CaptureCard } from "../capture/CaptureCard";

// Today's compact capture (#639): before interaction it is a single **New diary entry** control — the
// full typed/voice form, recording controls, and processing rows stay hidden until it is activated. The
// shared save-first `CaptureCard` (auto language detection, #647) does the actual capture; this wrapper
// only owns the compact ⇄ active ⇄ saved presentation so capture never dominates the calm page and never
// creates review work or changes completion.
//
// A capture succeeds two ways: a typed save (the CaptureCard hands back its diary Entry via `onCaptured`)
// or an accepted voice recording (saved server-side, signalled by `onVoiceAccepted` before background
// transcription finishes). Either returns to the compact state with a restrained confirmation and an
// Open in Diary link; the learner can start another entry immediately.
type CaptureMode = "active" | "compact" | "saved";

export function TodayCapture(): React.JSX.Element {
  const [mode, setMode] = useState<CaptureMode>("compact");

  if (mode === "active") {
    return (
      <section aria-label="New diary entry" className="flex flex-col gap-2">
        <CaptureCard onCaptured={() => setMode("saved")} onVoiceAccepted={() => setMode("saved")} />
        <div>
          <Button onClick={() => setMode("compact")} type="button" variant="secondary">
            Cancel
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="New diary entry" className="flex flex-col gap-2">
      <div>
        <Button onClick={() => setMode("active")} type="button" variant="secondary">
          New diary entry
        </Button>
      </div>
      {mode === "saved" ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted" role="status">
          Saved to your diary.
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} to="/diary">
            Open in Diary
          </Link>
        </p>
      ) : null}
    </section>
  );
}
