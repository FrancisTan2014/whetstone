import { describe, expect, it, vi } from "vitest";

import {
  createVoiceOut,
  pickEnglishVoice,
  type SpeechSynthesisLike,
  type VoiceOut
} from "./voiceOut.js";

function voice(lang: string, isDefault = false): SpeechSynthesisVoice {
  return {
    default: isDefault,
    lang,
    localService: true,
    name: lang,
    voiceURI: lang
  } satisfies SpeechSynthesisVoice;
}

type FakeUtterance = {
  text: string;
  voice?: SpeechSynthesisVoice;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

// A fake speech-synthesis API: records the last utterance and lets the test fire its end/error and the
// `voiceschanged` event, so createVoiceOut is exercised without jsdom implementing the Web Speech API.
function fakeSynthesis(initial: ReadonlyArray<SpeechSynthesisVoice>) {
  let voices = initial;
  let onVoicesChanged: (() => void) | null = null;
  let last: FakeUtterance | null = null;
  const cancel = vi.fn();

  const synthesis: SpeechSynthesisLike = {
    addEventListener: (_type, listener) => {
      onVoicesChanged = listener;
    },
    cancel,
    getVoices: () => voices,
    speak: (utterance) => {
      last = utterance as unknown as FakeUtterance;
    }
  };

  return {
    cancel,
    changeVoices: (next: ReadonlyArray<SpeechSynthesisVoice>) => {
      voices = next;
      onVoicesChanged?.();
    },
    last: () => last,
    synthesis
  };
}

function makeUtterance(text: string): SpeechSynthesisUtterance {
  return { onend: null, onerror: null, text } as unknown as SpeechSynthesisUtterance;
}

describe("pickEnglishVoice", () => {
  it("prefers the platform-default English voice", () => {
    const picked = pickEnglishVoice([voice("fr-FR", true), voice("en-GB"), voice("en-US", true)]);
    expect(picked?.lang).toBe("en-US");
  });

  it("falls back to en-US when no English voice is the default", () => {
    expect(pickEnglishVoice([voice("en-GB"), voice("en-US")])?.lang).toBe("en-US");
  });

  it("falls back to the first English voice when there is no en-US", () => {
    expect(pickEnglishVoice([voice("en-GB"), voice("en-AU")])?.lang).toBe("en-GB");
  });

  it("returns undefined when no voice is English", () => {
    expect(pickEnglishVoice([voice("fr-FR"), voice("de-DE")])).toBeUndefined();
  });
});

describe("createVoiceOut", () => {
  async function speakOnce(out: VoiceOut, fake: ReturnType<typeof fakeSynthesis>, text: string) {
    const pending = out.speak(text);
    fake.last()?.onend?.();
    await pending;
    return fake.last();
  }

  it("speaks with the chosen English voice and resolves when playback ends", async () => {
    const fake = fakeSynthesis([voice("en-US", true)]);
    const out = createVoiceOut(fake.synthesis, makeUtterance);

    const utterance = await speakOnce(out, fake, "Hello there");

    expect(utterance?.text).toBe("Hello there");
    expect(utterance?.voice?.lang).toBe("en-US");
  });

  it("resolves when playback errors rather than ending", async () => {
    const fake = fakeSynthesis([voice("en-US", true)]);
    const out = createVoiceOut(fake.synthesis, makeUtterance);

    const pending = out.speak("oops");
    fake.last()?.onerror?.();
    await expect(pending).resolves.toBeUndefined();
  });

  it("leaves the utterance voice unset when no English voice is available", async () => {
    const fake = fakeSynthesis([voice("fr-FR")]);
    const out = createVoiceOut(fake.synthesis, makeUtterance);

    const utterance = await speakOnce(out, fake, "bonjour");

    expect(utterance?.voice).toBeUndefined();
  });

  it("refreshes the voice when the browser loads voices asynchronously", async () => {
    const fake = fakeSynthesis([]);
    const out = createVoiceOut(fake.synthesis, makeUtterance);

    fake.changeVoices([voice("en-US", true)]);
    const utterance = await speakOnce(out, fake, "ready now");

    expect(utterance?.voice?.lang).toBe("en-US");
  });

  it("cancels playback for barge-in", () => {
    const fake = fakeSynthesis([voice("en-US", true)]);
    const out = createVoiceOut(fake.synthesis, makeUtterance);

    out.cancel();

    expect(fake.cancel).toHaveBeenCalledOnce();
  });
});
