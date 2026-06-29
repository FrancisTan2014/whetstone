import { useEffect, useRef, useState } from "react";

import type { DebriefDto, TranscribedWord } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import type { LiveCapture } from "./liveCapture";
import { endSession, say, startSession, transcribe } from "./sessionApi";
import type { VoiceOut } from "./voiceOut";

// The live call is set in one case (the conversation's situation); the first proposed cue supplies it.
type CallContext = Readonly<{
  caseId: string;
  communicativeFunction: string;
  situation: string;
}>;

// Who is speaking right now: idle (call not started), listening (capturing the learner), thinking
// (STT + coach, the latency window), or speaking (coach TTS playing).
type Phase = "idle" | "listening" | "thinking" | "speaking";

type Caption = Readonly<{ id: number; role: "user" | "coach"; text: string }>;

type Status =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "active"; call: CallContext }>
  | Readonly<{ kind: "debrief"; debrief: DebriefDto }>;

// The capture + voice halves of a running call, held together so they start and tear down as one.
type LiveSession = Readonly<{ capture: LiveCapture; voice: VoiceOut }>;

// The browser-dependent halves of the loop, injected so the page is testable with fakes: mic capture +
// endpointing (#219) and TTS out (#221). Absent = no-mic, typed-only fallback. `supported` is the
// feature-detect (`navigator.mediaDevices?.getUserMedia`): false on a non-secure context or no device,
// so the voice path is hidden and the call opens typed-only — never a fatal screen.
export type LiveDependencies = Readonly<{
  createCapture: (callbacks: {
    onUtterance: (audio: Blob) => void;
    onBargeIn?: () => void;
    onUtteranceStart?: () => void;
  }) => LiveCapture;
  createVoiceOut: () => VoiceOut;
  supported: boolean;
}>;

type SessionPageProps = Readonly<{
  live?: LiveDependencies;
  // The soft time-box (~15 min) after which the coach offers to "land the plane" — a calm, non-blocking
  // nudge, never a hard cutoff. Injectable so the nudge is testable without waiting real minutes.
  timeBoxMs?: number;
}>;

const DEFAULT_TIME_BOX_MS = 15 * 60 * 1000;

const phaseLabels: Readonly<Record<Phase, string>> = {
  idle: "Ready when you are",
  listening: "Listening…",
  speaking: "Coach is speaking",
  thinking: "Coach is thinking…"
};

export function SessionPage({
  live,
  timeBoxMs = DEFAULT_TIME_BOX_MS
}: SessionPageProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [captions, setCaptions] = useState<ReadonlyArray<Caption>>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [started, setStarted] = useState(false);
  const [micUnavailable, setMicUnavailable] = useState(false);
  const [wrapUp, setWrapUp] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const liveRef = useRef<LiveSession | null>(null);
  const captionSeq = useRef(0);
  // The round's STT word-timings, accumulated across utterances and sent to the analysis pass on End.
  const wordsRef = useRef<TranscribedWord[]>([]);

  function appendCaption(role: Caption["role"], text: string): void {
    const id = (captionSeq.current += 1);
    setCaptions((prev) => [...prev, { id, role, text }]);
  }

  function teardown(): void {
    const session = liveRef.current;
    if (session !== null) {
      session.capture.stop();
      session.voice.cancel();
    }
    liveRef.current = null;
  }

  // One learner turn: show what they said, ask the coach (the latency window), speak the reply, and
  // return to listening. No per-turn grading — that is the end-of-round job (#222).
  async function runTurn(call: CallContext, transcript: string): Promise<void> {
    appendCaption("user", transcript);
    setPhase("thinking");

    const reply = await say({ caseId: call.caseId, transcript });
    appendCaption("coach", reply.say);
    if (reply.repair !== undefined) {
      appendCaption("coach", reply.repair.recast);
    }

    const session = liveRef.current;
    if (session !== null) {
      setPhase("speaking");
      session.capture.setCoachPlaying(true);
      await session.voice.speak(reply.say);
      session.capture.setCoachPlaying(false);
    }

    setPhase(liveRef.current !== null ? "listening" : "idle");
  }

  function guarded(work: () => Promise<void>): Promise<void> {
    return work().catch(() => {
      teardown();
      setStatus({ kind: "error" });
    });
  }

  async function onUtterance(call: CallContext, audio: Blob): Promise<void> {
    setPhase("thinking");
    const { transcript, words } = await transcribe(audio);
    wordsRef.current = [...wordsRef.current, ...words];
    await runTurn(call, transcript);
  }

  // Open the live call. A mic-start failure (denied/absent device, or a non-secure context where
  // `getUserMedia` rejects) is NOT fatal: tear the capture half down and stay active, typed-only, with a
  // calm notice. Only genuine session API failures (transcribe/say/end) reach `guarded`'s fatal screen.
  function startCall(call: CallContext, deps: LiveDependencies): Promise<void> {
    const voice = deps.createVoiceOut();
    const capture = deps.createCapture({
      onBargeIn: () => {
        voice.cancel();
        capture.setCoachPlaying(false);
        setPhase("listening");
      },
      onUtterance: (audio) => void guarded(() => onUtterance(call, audio))
    });
    liveRef.current = { capture, voice };
    return capture.start().then(
      () => {
        setStarted(true);
        setPhase("listening");
      },
      () => {
        teardown();
        setMicUnavailable(true);
      }
    );
  }

  // End the round: tear down the live call, run the one analysis pass + deposit (server), and show the
  // debrief. Grading happens only here.
  function endCall(call: CallContext): Promise<void> {
    return guarded(async () => {
      teardown();
      setPhase("thinking");
      const debrief = await endSession({ caseId: call.caseId, words: wordsRef.current });
      setStatus({ kind: "debrief", debrief });
    });
  }

  // Event-handler reload (retry / start another): show loading and re-run the load effect via its key,
  // so the effect (not this handler) performs the async fetch + setState.
  function reload(): void {
    setStatus({ kind: "loading" });
    setReloadKey((prev) => prev + 1);
  }

  // Load the plan on mount and whenever `reloadKey` changes. The async work is defined inside the effect
  // and awaits before any setState, so it never sets state synchronously within the effect body.
  useEffect(() => {
    async function init(): Promise<void> {
      try {
        const plan = await startSession();
        const cue = plan.cues[0];
        if (cue === undefined) {
          setStatus({ kind: "empty" });
          return;
        }
        setCaptions([]);
        setPhase("idle");
        setStarted(false);
        setMicUnavailable(false);
        setWrapUp(false);
        wordsRef.current = [];
        setStatus({
          call: {
            caseId: cue.caseId,
            communicativeFunction: cue.communicativeFunction,
            situation: cue.situation
          },
          kind: "active"
        });
      } catch {
        setStatus({ kind: "error" });
      }
    }

    void init();
    return () => {
      teardown();
    };
  }, [reloadKey]);

  // The "land the plane" nudge: once a round is active, after the soft time-box surface a calm offer to
  // stop. Non-blocking — the call keeps running and the explicit End control still works; this only
  // reveals the prompt. The timer is cleared when the round ends or reloads.
  useEffect(() => {
    if (status.kind !== "active") {
      return;
    }
    const timer = setTimeout(() => setWrapUp(true), timeBoxMs);
    return () => clearTimeout(timer);
  }, [status.kind, timeBoxMs]);

  if (status.kind === "loading") {
    return <LoadingIndicator label="Setting up your call…" />;
  }

  if (status.kind === "error") {
    return (
      <Shell>
        <div role="alert">
          <p className="text-danger">Something went wrong with your call.</p>
          <Button className="mt-3" onClick={reload}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  if (status.kind === "empty") {
    return (
      <Shell>
        <p className="text-text-muted">
          Nothing to practise right now — every region of your world is lit. Add reading or check
          back later.
        </p>
      </Shell>
    );
  }

  if (status.kind === "debrief") {
    return <DebriefView debrief={status.debrief} onRestart={reload} />;
  }

  return (
    <CallView
      call={status.call}
      captions={captions}
      endCall={() => void endCall(status.call)}
      liveDeps={live}
      micUnavailable={micUnavailable}
      onSend={(transcript) => void guarded(() => runTurn(status.call, transcript))}
      onStart={(deps) => void startCall(status.call, deps)}
      phase={phase}
      started={started}
      wrapUp={wrapUp}
    />
  );
}

function Shell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <section aria-labelledby="session-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="session-heading">
        Practice
      </h1>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function CallView({
  call,
  captions,
  endCall,
  liveDeps,
  micUnavailable,
  onSend,
  onStart,
  phase,
  started,
  wrapUp
}: Readonly<{
  call: CallContext;
  captions: ReadonlyArray<Caption>;
  endCall: () => void;
  liveDeps: LiveDependencies | undefined;
  micUnavailable: boolean;
  onSend: (transcript: string) => void;
  onStart: (deps: LiveDependencies) => void;
  phase: Phase;
  started: boolean;
  wrapUp: boolean;
}>): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const busy = phase === "thinking" || phase === "speaking";
  // Offer voice only when the browser supports capture and a previous start hasn't already degraded to
  // typed-only; otherwise the call runs on the typed box, which is always present.
  const canStart = liveDeps?.supported === true && !started && !micUnavailable;

  function submitTyped(): void {
    const transcript = typed.trim();
    if (transcript.length === 0) {
      return;
    }
    setTyped("");
    onSend(transcript);
  }

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        <div className="rounded border border-border bg-surface p-4">
          <p className="text-sm text-text-muted">{call.communicativeFunction}</p>
          <p className="text-lg text-text">{call.situation}</p>
        </div>

        {wrapUp ? (
          <p
            className="rounded border border-border bg-surface px-3 py-2 text-sm text-text-muted"
            role="status"
          >
            Nice and natural place to land the plane — wrap up whenever you're ready, no rush.
          </p>
        ) : null}

        {micUnavailable ? (
          <p
            className="rounded border border-border bg-surface px-3 py-2 text-sm text-text-muted"
            role="status"
          >
            Mic unavailable — type your reply, or enable the mic and reload.
          </p>
        ) : null}

        {started ? <p className="text-sm font-medium text-text">{phaseLabels[phase]}</p> : null}

        <ul aria-label="Conversation" aria-live="polite" className="flex flex-col gap-2">
          {captions.map((caption) => (
            <li
              className={
                caption.role === "coach"
                  ? "self-start rounded bg-surface px-3 py-2 text-text"
                  : "self-end rounded bg-bg px-3 py-2 text-text"
              }
              key={caption.id}
            >
              <span className="block text-xs text-text-muted">
                {caption.role === "coach" ? "Coach" : "You"}
              </span>
              {caption.text}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          {liveDeps !== undefined && canStart ? (
            <Button onClick={() => onStart(liveDeps)} type="button">
              Start call
            </Button>
          ) : null}
          <Button onClick={endCall} type="button" variant="secondary">
            End &amp; review
          </Button>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <label className="text-sm text-text-muted" htmlFor="session-typed">
            Or type what you&apos;d say
          </label>
          <textarea
            className="min-h-20 rounded border border-border bg-surface p-3 text-text"
            id="session-typed"
            onChange={(event) => setTyped(event.currentTarget.value)}
            value={typed}
          />
          <Button
            className="self-start"
            onClick={submitTyped}
            pending={busy}
            type="button"
            variant="secondary"
          >
            Send
          </Button>
        </div>
      </div>
    </Shell>
  );
}

// The compact end-of-round debrief (#222): encouragement, the few moments that matter (said -> native +
// why), the one upgrade to carry, wins, and what is now due to recall. Calm, not a wall of corrections.
function DebriefView({
  debrief,
  onRestart
}: Readonly<{
  debrief: DebriefDto;
  onRestart: () => void;
}>): React.JSX.Element {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <p className="text-lg text-text">{debrief.encouragement}</p>

        {debrief.wins.length > 0 ? (
          <ul aria-label="Wins" className="flex flex-wrap gap-2">
            {debrief.wins.map((win) => (
              <li className="rounded bg-surface px-2 py-1 text-sm text-success" key={win}>
                {win}
              </li>
            ))}
          </ul>
        ) : null}

        <section aria-labelledby="debrief-moments-heading" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text" id="debrief-moments-heading">
            Moments to carry
          </h2>
          {debrief.moments.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {debrief.moments.map((moment) => (
                <li className="rounded border border-border bg-surface p-3" key={moment.native}>
                  <p className="text-text">
                    <span className="text-text-muted">{moment.said || "—"}</span>
                    {" → "}
                    <span className="font-medium">{moment.native}</span>
                  </p>
                  <p className="mt-1 text-sm text-text-muted">{moment.why}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-text-muted">Smooth round — nothing needed correcting.</p>
          )}
        </section>

        <div className="rounded border border-border bg-surface p-3">
          <p className="text-sm text-text-muted">One upgrade to carry</p>
          <p className="text-text">
            <span className="text-text-muted">{debrief.upgrade.said}</span>
            {" → "}
            <span className="font-medium">{debrief.upgrade.native}</span>
          </p>
        </div>

        {debrief.due.length > 0 ? (
          <section aria-labelledby="debrief-due-heading" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-text" id="debrief-due-heading">
              Now due to recall
            </h2>
            <ul className="flex flex-col gap-1">
              {debrief.due.map((item) => (
                <li className="text-sm text-text" key={item.text}>
                  {item.text}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <Button className="self-start" onClick={onRestart} type="button">
          Practise again
        </Button>
      </div>
    </Shell>
  );
}
