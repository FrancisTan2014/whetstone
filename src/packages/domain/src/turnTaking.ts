// Pure turn-taking orchestration (#219): layers conversational turn state on top of the endpointer so
// the live call loop can be driven without a real microphone or audio element. Its one job is to turn
// endpointing decisions into turn effects given who is currently speaking — in particular **barge-in**:
// if the learner starts an utterance while the coach is playing, that is an interruption, not a normal
// turn start, and the consumer should stop playback and switch to capture.
//
// No DOM, audio, or timers live here; the browser layer sets `coachPlaying` when it starts/stops TTS and
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
  // "barge-in": utterance started while the coach was playing — interrupt playback and capture.
  // "utterance-start": utterance started while the coach was idle — begin capture.
  // "utterance-end": utterance finished — finalize and hand off the captured audio.
  type: "barge-in" | "utterance-start" | "utterance-end";
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

// True while the learner's utterance is being captured.
export function isListening(state: TurnTakingState): boolean {
  return isCapturingUtterance(state.endpointer);
}

// Record that the coach started or stopped speaking. The consumer calls this around TTS playback so a
// later utterance-start can be recognized as a barge-in.
export function setCoachPlaying(state: TurnTakingState, playing: boolean): TurnTakingState {
  return { ...state, coachPlaying: playing };
}

// Map an endpointing decision to a turn effect. A start while the coach plays is a barge-in and clears
// the playing flag, since the learner has taken the floor; a start while idle is a normal turn start.
function applyEvent(
  state: TurnTakingState,
  event: EndpointEvent,
  endpointer: EndpointerState
): TurnStep {
  if (event.type === "utterance-end") {
    return { effect: { type: "utterance-end" }, state: { ...state, endpointer } };
  }

  if (state.coachPlaying) {
    return { effect: { type: "barge-in" }, state: { coachPlaying: false, endpointer } };
  }

  return { effect: { type: "utterance-start" }, state: { ...state, endpointer } };
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
