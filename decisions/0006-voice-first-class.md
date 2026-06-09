# ADR 0006 — Voice as first-class; local STT on every client; pronunciation scoring deferred

**Date:** 2026-06-09
**Status:** Accepted (the "Audio never leaves the device" / "Local-only" privacy framing in Decision §2 superseded by [ADR 0010](./0010-audio-sync.md); voice-first-class, local Whisper STT, and the v1 in/out scope all stand)

## Context

Earlier ADRs treated whetstone as text-in / text-out. The user explicitly rejected this scope: whetstone is intended to be a personal knowledge library, and the user has *"struggled so long on switching platforms"* — multiple apps for the same kind of intellectual work erodes the integration whetstone exists to provide.

Voice matters specifically for:
- **Diary entries** — sometimes thinking happens better aloud than on a keyboard, particularly across two languages.
- **Recitation** — recitation is *spoken*; testing it via typing collapses what's actually being practiced.
- **Spoken English practice** — the user identified a real, persistent gap in their current self-study.
- **Reflection / mirror response** — speaking the response when writing feels heavy.

The user also constrained the implementation: clients carry the STT model locally; mobile clients should be able to record and process without a server.

The honest question was: how much of "voice support" can v1 ship without becoming a different project? Pronunciation quality scoring (stress, rhythm, phoneme accuracy) is meaningfully harder than transcription and the OSS landscape is uneven — partly solved for English, much weaker for classical Chinese recitation.

## Decision

1. **Voice input is first-class everywhere text input is**: diary, reflection, recall responses, recitation, prose-modeling notes. Tap mic, speak, audio recorded and stored alongside the encounter.

2. **STT is local on every client**: Whisper (whisper.cpp or faster-whisper) bundled with the app. Audio never leaves the device. No server-side processing in v1. Privacy is a side effect of this architecture; cost is zero per minute forever.
   > **Superseded by ADR 0010:** Whisper STT remains local on every client, but the original audio bytes are uploaded to the user's own server (MBP at home in v1, user-owned cloud later) so the recording is playable on every device. The privacy framing is updated from *"audio never leaves the device"* to *"audio never leaves user-controlled hardware."* STT remains zero-cost-per-minute; audio never reaches a third-party service.

3. **The model is bundled**: app size increases by 100-500 MB depending on which Whisper variant is selected. Acceptable on modern phones per user.

4. **Transcripts drive grading and search**: the transcript flows into LLM grading and is the searchable form. The original audio is preserved for playback.

5. **`IAudioProcessor` is the third real seam** (alongside `INoteStore` and `IGrader`). v1 implementation: `WhisperAudioProcessor`. Pronunciation-scoring implementations are an interface extension deferred to v2.

6. **v1 voice scope (in)**:
   - Recording, transcription, playback.
   - Recitation: character-match against original via transcript; flags substitutions and omissions.
   - English prose reading aloud: transcript-only; pronunciation scoring deferred.

7. **v1 voice scope (out)**:
   - Pronunciation-quality scoring for English (stress, rhythm, phonemes).
   - Literary-quality scoring for Chinese recitation (节奏, 情感, breath).
   - TTS (app reading material to you).
   - Real-time / streaming transcription.

## Alternatives considered

- **Text-only v1, voice in v2**: rejected. The user committed to whetstone-as-personal-knowledge-library and explicitly rejected platform-switching. Deferring voice means the user defers whetstone.
- **Server-side STT for mobile (cloud Whisper API or Azure Speech)**: rejected. Forces v1 to provision a server, adds per-minute cost, breaks the local-first architecture. The user explicitly required local processing on all clients.
- **Pronunciation scoring in v1 (OSS wav2vec2 + MFA stack)**: rejected. Real engineering work (2-3 weekends of v1 work, plus ongoing tuning) for a feature whose value over text-only voice is incremental in v1. OSS pronunciation scoring for Chinese recitation is research-thin; promising "literary quality scoring" in v1 would be dishonest.
- **TTS in v1**: rejected. Useful for recitation reference but not on the critical path. Coqui TTS or similar OSS stack is the v2 implementation.
- **Smaller Whisper model only (~100 MB), pure mobile-first**: considered. The selection of which Whisper variant to bundle is left to implementation — likely `small` for mobile, `medium` available for desktop. Not pre-decided in this ADR.
- **Separate audio storage outside `INoteStore`**: rejected. Audio is part of the encounter; the note references the audio by filename and they live together. Single export bundle covers both.

## Consequences

**Positive:**
- whetstone becomes the single place for the user's intellectual work — including the spoken parts. No platform-switching.
- Audio never leaves the device. Privacy is structural.
- Zero per-minute STT cost forever.
- The `IAudioProcessor` seam allows v2 to add pronunciation scoring (cloud or OSS) without rewriting v1 callers.
- Diary-as-voice is enabled. Conviction #6 ("meeting your past self") gets a richer past self — voice diaries carry tone in a way text doesn't.

**Negative / accepted risk:**
- App size grows by 100-500 MB. Acceptable per user given modern device storage.
- v1 adds 2-3 weekends of work over the text-only version (recording UI, audio storage, Whisper integration, transcript pipeline). Pushes first usable v1 by ~2-3 weeks.
- Whisper transcription quality varies by model size, accent, and noise. The user may need to re-record occasionally. Acceptable.
- Mobile build complexity is higher with bundled Whisper than with text-only. Mobile is deferred to v1.5 / v2, but the architecture must already support it.
- Pronunciation feedback is *not* in v1 even though it was the user's underlying interest in adding voice. The user accepted that v1 ships voice recording + transcription only; pronunciation scoring follows in v2. This is the most likely point of frustration — needs to be revisited if the user reaches v1 daily-use and the missing pronunciation feedback is the dominant pain.

## Revisit triggers

- v1 daily use shows that recitation transcript-matching is insufficient feedback → prioritize pronunciation scoring in v1.5.
- Whisper model size proves prohibitive on intended target phones → revisit the bundled-vs-server decision.
- The user uses voice diary daily → confirms the architecture was worth it; consider voice quality-of-life features (waveform display, playback speed).
- The user never uses voice → the cost was wrong; consider trimming Whisper to a "diary only" minimal install.
- OSS pronunciation scoring landscape changes meaningfully → re-evaluate v2 implementation effort.
