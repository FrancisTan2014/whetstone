import { useEffect, useRef, useState } from "react";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import type { LiveCapture } from "./liveCapture";
import { say, startSession, transcribe } from "./sessionApi";
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
  | Readonly<{ kind: "ended" }>;

// The capture + voice halves of a running call, held together so they start and tear down as one.
type LiveSession = Readonly<{ capture: LiveCapture; voice: VoiceOut }>;

// The browser-dependent halves of the loop, injected so the page is testable with fakes: mic capture +
// endpointing (#219) and TTS out (#221). Absent = no-mic, typed-only fallback.
export type LiveDependencies = Readonly<{
  createCapture: (callbacks: {
    onUtterance: (audio: Blob) => void;
    onBargeIn?: () => void;
    onUtteranceStart?: () => void;
  }) => LiveCapture;
  createVoiceOut: () => VoiceOut;
}>;

type SessionPageProps = Readonly<{
  live?: LiveDependencies;
}>;

const phaseLabels: Readonly<Record<Phase, string>> = {
  idle: "Ready when you are",
  listening: "Listening…",
  speaking: "Coach is speaking",
  thinking: "Coach is thinking…"
};

export function SessionPage({ live }: SessionPageProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [captions, setCaptions] = useState<ReadonlyArray<Caption>>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState(0);
  const [started, setStarted] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const liveRef = useRef<LiveSession | null>(null);
  const captionSeq = useRef(0);

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
    setTurns((prev) => prev + 1);
  }

  function guarded(work: () => Promise<void>): Promise<void> {
    return work().catch(() => {
      teardown();
      setStatus({ kind: "error" });
    });
  }

  async function onUtterance(call: CallContext, audio: Blob): Promise<void> {
    setPhase("thinking");
    const { transcript } = await transcribe(audio);
    await runTurn(call, transcript);
  }

  function startCall(call: CallContext, deps: LiveDependencies): Promise<void> {
    return guarded(async () => {
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
      await capture.start();
      setStarted(true);
      setPhase("listening");
    });
  }

  function endCall(): void {
    teardown();
    setStatus({ kind: "ended" });
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
        setTurns(0);
        setStarted(false);
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

  if (status.kind === "ended") {
    return (
      <Shell>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-text">Call complete</h2>
          <p className="text-text-muted">You spoke {turns} turn(s) with the coach.</p>
          <Button className="self-start" onClick={reload}>
            Start another
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <CallView
      call={status.call}
      captions={captions}
      endCall={endCall}
      liveDeps={live}
      onSend={(transcript) => void guarded(() => runTurn(status.call, transcript))}
      onStart={(deps) => void startCall(status.call, deps)}
      phase={phase}
      started={started}
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
  onSend,
  onStart,
  phase,
  started
}: Readonly<{
  call: CallContext;
  captions: ReadonlyArray<Caption>;
  endCall: () => void;
  liveDeps: LiveDependencies | undefined;
  onSend: (transcript: string) => void;
  onStart: (deps: LiveDependencies) => void;
  phase: Phase;
  started: boolean;
}>): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const busy = phase === "thinking" || phase === "speaking";

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
          {liveDeps !== undefined && !started ? (
            <Button onClick={() => onStart(liveDeps)} type="button">
              Start call
            </Button>
          ) : null}
          {started ? (
            <Button onClick={endCall} type="button" variant="secondary">
              End
            </Button>
          ) : null}
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
