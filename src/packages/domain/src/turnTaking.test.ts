import { describe, expect, it } from "vitest";

import { type EndpointConfig } from "./endpointing.js";
import {
  createTurnTaking,
  finishTurn,
  isListening,
  observeFrame,
  setCoachPlaying,
  type TurnStep,
  type TurnTakingState
} from "./turnTaking.js";

const config: EndpointConfig = {
  endSilenceMs: 200,
  frameMs: 20,
  minSpeechMs: 100,
  noiseFloor: 0.1
};

const VOICED = 1;
const SILENT = 0;

function frames(count: number, energy: number): ReadonlyArray<number> {
  return Array.from({ length: count }, () => energy);
}

// Feed frames, collecting every non-null effect along the way.
function observe(
  state: TurnTakingState,
  energies: ReadonlyArray<number>
): Readonly<{ effects: ReadonlyArray<string>; state: TurnTakingState }> {
  let current = state;
  const effects: string[] = [];
  for (const energy of energies) {
    const step: TurnStep = observeFrame(current, energy);
    current = step.state;
    if (step.effect !== null) {
      effects.push(step.effect.type);
    }
  }
  return { effects, state: current };
}

describe("turnTaking — barge-in and turn effects", () => {
  it("starts idle, not listening, with the coach silent", () => {
    const state = createTurnTaking(config);

    expect(isListening(state)).toBe(false);
    expect(state.coachPlaying).toBe(false);
  });

  it("emits utterance-start then utterance-end across a full turn when the coach is idle", () => {
    const { effects, state } = observe(createTurnTaking(config), [
      ...frames(5, VOICED),
      ...frames(10, SILENT)
    ]);

    expect(effects).toEqual(["utterance-start", "utterance-end"]);
    expect(isListening(state)).toBe(false);
  });

  it("emits no effect on frames that do not complete a decision", () => {
    const step = observeFrame(createTurnTaking(config), SILENT);

    expect(step.effect).toBeNull();
    expect(isListening(step.state)).toBe(false);
  });

  it("raises barge-in when the learner starts speaking while the coach is playing", () => {
    const playing = setCoachPlaying(createTurnTaking(config), true);

    const { effects, state } = observe(playing, frames(5, VOICED));

    expect(effects).toEqual(["barge-in"]);
    expect(state.coachPlaying).toBe(false); // taking the floor stops coach playback
    expect(isListening(state)).toBe(true);
  });

  it("reports listening while an utterance is captured", () => {
    const { state } = observe(createTurnTaking(config), frames(5, VOICED));

    expect(isListening(state)).toBe(true);
  });
});

describe("turnTaking — finishTurn (tap to finish)", () => {
  it("force-ends the current utterance", () => {
    const { state } = observe(createTurnTaking(config), frames(6, VOICED));

    const step = finishTurn(state);

    expect(step.effect).toEqual({ type: "utterance-end" });
    expect(isListening(step.state)).toBe(false);
  });

  it("is a no-op when no utterance is in progress", () => {
    const idle = createTurnTaking(config);

    const step = finishTurn(idle);

    expect(step.effect).toBeNull();
    expect(isListening(step.state)).toBe(false);
  });
});
