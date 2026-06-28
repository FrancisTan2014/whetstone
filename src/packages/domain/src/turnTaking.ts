// Pure turn-taking orchestration (#219): layers conversational turn state on top of the endpointer so
// the live call loop can be driven without a real microphone or audio element. It maps endpointing
// decisions to turn **effects** the consumer acts on:
//
// - `capture-start` — a candidate utterance began; start buffering microphone audio from the onset.
// - `capture-discard` — the candidate died before confirming; throw the buffered audio away.
// - `utterance-start` — the utterance confirmed while the coach was idle; commit the buffer.
// - `barge-in` — the utterance confirmed while the coach was playing; an interruption, so the consumer
//   stops playback and commits the buffer. Confirmation (not the speculative candidate) triggers
//   barge-in, so a transient noise during coach speech never cuts the coach off.
// - `utterance-end` — the utterance finished; finalize and hand off the captured audio.
//
// No DOM, audio, or timers live here; the browser layer sets `coachPlaying` around TTS playback and
// forwards energy frames, then dispatches the returned effect.

import {
  createEndpointer,
  forceEndUtterance,
  isCapturingUtterance,
  pushFrame,
  type EndpointConfig,
  type EndpointEvent,
  type EndpointerState
} from "./endpointing.js";

export type TurnEffect = Readonly<{
  type: "capture-start" | "capture-discard" | "utterance-start" | "barge-in" | "utterance-end";
}>;

export type TurnTakingState = Readonly<{
  endpointer: EndpointerState;
  // Whether the coach is currently producing voice output; the consumer toggles this around playback.
  coachPlaying: boolean;
}>;

export type TurnStep = Readonly<{
  state: TurnTakingState;
  effect: TurnEffect | null;
}>;

export function createTurnTaking(config: EndpointConfig): TurnTakingState {
  return { coachPlaying: false, endpointer: createEndpointer(config) };
}

// True while a confirmed utterance is being captured.
export function isListening(state: TurnTakingState): boolean {
  return isCapturingUtterance(state.endpointer);
}

// Record that the coach started or stopped speaking. The consumer calls this around TTS playback so a
// later confirmed start can be recognized as a barge-in.
export function setCoachPlaying(state: TurnTakingState, playing: boolean): TurnTakingState {
  return { ...state, coachPlaying: playing };
}

// Map an endpointing decision to a turn effect. A confirmed start while the coach plays is a barge-in
// and clears the playing flag, since the learner has taken the floor.
function applyEvent(
  state: TurnTakingState,
  event: EndpointEvent,
  endpointer: EndpointerState
): TurnStep {
  switch (event.type) {
    case "speech-candidate":
      return { effect: { type: "capture-start" }, state: { ...state, endpointer } };
    case "speech-aborted":
      return { effect: { type: "capture-discard" }, state: { ...state, endpointer } };
    case "utterance-end":
      return { effect: { type: "utterance-end" }, state: { ...state, endpointer } };
    default:
      if (state.coachPlaying) {
        return { effect: { type: "barge-in" }, state: { coachPlaying: false, endpointer } };
      }
      return { effect: { type: "utterance-start" }, state: { ...state, endpointer } };
  }
}

// Feed one energy frame; advance turn state and return any effect the consumer should act on.
export function observeFrame(state: TurnTakingState, energy: number): TurnStep {
  const { event, state: endpointer } = pushFrame(state.endpointer, energy);
  if (event === null) {
    return { effect: null, state: { ...state, endpointer } };
  }
  return applyEvent(state, event, endpointer);
}

// "Tap to finish": force the current utterance to end. No-op when not listening.
export function finishTurn(state: TurnTakingState): TurnStep {
  const { event, state: endpointer } = forceEndUtterance(state.endpointer);
  if (event === null) {
    return { effect: null, state: { ...state, endpointer } };
  }
  return applyEvent(state, event, endpointer);
}
