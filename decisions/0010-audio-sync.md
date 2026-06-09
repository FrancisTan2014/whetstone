# ADR 0010 — Audio sync across devices; supersedes the "audio never leaves the device" stance

**Date:** 2026-06-09
**Status:** Accepted
**Supersedes:** Parts of [ADR 0006](./0006-voice-first-class.md) (specifically the "Local-only" sub-claim and the "Audio never leaves the device" framing). The rest of ADR 0006 — voice as first-class, local Whisper STT, in/out v1 scope — stands.

## Context

[ADR 0006](./0006-voice-first-class.md) established voice as a first-class input in whetstone and committed that **audio never leaves the device**. That commitment was reasonable under the then-prevailing assumption (no server, no sync, manual zip-export for cross-device). It is no longer reasonable under the [ADR 0008](./0008-system-architecture.md) system architecture, which adds server-mediated cross-device sync as a v1 capability.

The concrete failure mode under ADR 0006's stance + ADR 0008's sync architecture:

- User records a voice diary on their phone in the morning.
- The note's metadata syncs to the server, then to the user's laptop.
- The laptop sees: *"voice diary, transcribed, audio not available on this device."*
- The user cannot play back the audio they just recorded.

This is the exact platform-switching pain ADR 0006's preamble names as the reason voice exists in whetstone at all (*"struggled so long on switching platforms"*). Preserving "audio never leaves the device" literally would re-create the multi-platform fragmentation whetstone was built to escape.

The user reviewed the trade-off and chose **full audio sync across devices**.

## Decision

1. **Audio blobs sync to the user's own server** alongside note metadata. The server (running on the user's MacBook Pro in v1, on user-controlled cloud later) stores the original audio file as a blob via `IAudioBlobStore`.

2. **The revised privacy claim is:** *audio never leaves user-controlled hardware*. v1 hardware = the user's MBP. v2 hardware = the user's own cloud account (Ali Cloud OSS, Azure Blob, etc.) provisioned and paid for by the user. **Audio does not reach a third party in either case.**

3. **Cloudflare Tunnel handles transit**: audio bytes flow TLS-encrypted from client through Cloudflare to the MBP. Cloudflare sees only encrypted bytes (TLS terminated inside the tunnel proxy on the MBP, not at the Cloudflare edge).

4. **STT remains local on every client**: Whisper continues to transcribe on the recording device. Audio bytes go to the server *after* the user accepts the recording; the transcript is generated locally first. This preserves Whisper-as-local from ADR 0006.

5. **The Anthropic critical path does not touch audio**. Anthropic receives the *transcript text only*, never the audio bytes. (This was already true under ADR 0006; restating to be clear it survives this ADR.)

6. **On-device caching**: clients keep audio they recorded locally indefinitely; audio recorded on *other* devices is downloaded lazily on playback request and cached locally for subsequent plays. Cache eviction policy is implementation detail (likely LRU with a configurable cap; defaults that fit on mobile).

7. **Audio is part of the export**: `ExportService` includes all audio blobs the user has downloaded (or downloads them as part of export) into the zip. The export remains the v1 portability escape hatch.

8. **The server stores audio behind `IAudioBlobStore`** (new fourth seam, justified in [ADR 0008 §10](./0008-system-architecture.md)). v1 implementation: local disk on the MBP. v2 / on cloud migration: S3-compatible (Ali OSS, Azure Blob, AWS S3, MinIO). No server code change to migrate.

## Alternatives considered

- **Keep "audio never leaves the device" literally; sync only transcripts.** Rejected as the original position now contradicting the cross-device promise. User explicitly chose audio sync over literal preservation of the older claim.
- **User-configurable per-device sync toggle ("sync audio? on/off").** Considered. Rejected for v1 because it produces a worse default (some devices have audio, some don't, hard for the user to remember which is which) and adds UI surface for a benefit (privacy-conscious users) that the v1 user has explicitly disclaimed wanting. Can be added in v1.5 if real users want it.
- **Sync compressed transcripts only; audio stays local but downloadable on demand via a peer-to-peer mechanism.** Rejected as over-engineering for v1. P2P between user's own devices is a v2+ concept; the user-owned server is the simpler answer for the same use case.
- **Use a third-party audio storage service** (S3 with default region, Cloudflare R2, Backblaze B2). Rejected because it directly contradicts the privacy posture: audio reaches a third party. The user-owned MBP, and later the user-owned cloud account, are the right scope.
- **Encrypt audio client-side with a user-held key before upload** ("the server holds ciphertext only"). Considered. Rejected for v1 because: (a) it adds key management complexity (where does the key live? how does a new device get it?), (b) on a user-owned server, the user already has plaintext access via SSH anyway — the encryption would be ceremony without actual confidentiality benefit, (c) v2 cloud migration is the right place to revisit this (cloud blob storage on Ali Cloud has different threat model). Likely future ADR when v2 cloud migration is real.
- **Lossy compression on upload** (Opus 32kbps instead of original WAV). Considered. Rejected for v1 because Whisper transcription quality is sensitive to lossy compression and we want the audio to also be the source of truth for any future re-transcription. v1 stores the original recording format. v1.5 compression-on-upload is reasonable if storage becomes a real concern.

## Consequences

**Positive:**

- **Cross-device audio continuity**: voice diary recorded on phone is playable on laptop, on web, anywhere the user is signed in. Conviction #6 ("meeting your past self") now includes the audio of past-self, not just the transcript.
- **The privacy claim becomes more precise and more defensible**: "audio stays on user-controlled hardware" is enforceable by the architecture (MBP-at-home or user's own cloud); the original "never leaves the device" was breaking the moment sync entered scope.
- **`IAudioBlobStore` seam validated**: same interface, different implementations for MBP-local vs cloud-blob. v2 migration is config + data move.
- **Whisper-as-local is preserved**: transcription still happens on the recording device. No audio bytes go to a server before the user has seen the transcript.
- **Anthropic never receives audio**: only transcripts. The LLM cost model in STABLE.md is unaffected.

**Negative / accepted risk:**

- **Storage on MBP grows** with audio retention. Estimate: ~50 MB/month at daily voice diary use; ~600 MB/year. Acceptable on modern MBP storage; documented in the v1 setup runbook. Future pruning policy (e.g., "drop audio older than 1 year, keep transcript") is a v1.5 nice-to-have.
- **Bandwidth on initial sync** can be substantial if the user records long audio and a new client joins (e.g., installing whetstone on a fresh device). Acceptable; mitigated by lazy-download (audio for an old note pulls only when the user opens that note).
- **MBP downtime means audio not yet uploaded can't reach other devices.** Same as note sync downtime; same mitigation (queue + retry).
- **The privacy story is harder to explain to a future user** than "audio never leaves the device" was. The new statement requires understanding that "user-controlled hardware" is a specific commitment (the user provisioned and pays for the storage; no third-party storage service is involved). Documented in the v1 readme.
- **Cloud migration story for audio** has more weight than for notes (notes are small; audio is large). Migration script in [ADR 0008 §12](./0008-system-architecture.md) explicitly addresses bulk audio transfer via `rsync` or equivalent.

## Revisit triggers

- **Cloud migration** (v1.5 or v2): re-evaluate envelope encryption for audio at rest on cloud blob storage. The threat model changes (cloud provider has plaintext access to bytes).
- **Real user storage pressure** on MBP or on cloud: revisit retention policy (e.g., "drop audio after 1 year, keep transcript").
- **Bandwidth costs become real** after cloud migration (Ali Cloud egress to your devices): revisit lossy compression on upload.
- **Multi-user scenario** ever materializes: revisit ACLs on audio (currently single-user, owner is implicit).
- **Pronunciation-scoring lands in v2**: pronunciation analysis may want to run server-side rather than per-client. Re-examine the "transcription is local" stance; pronunciation scoring may justify server-side audio processing (which is different from third-party audio access — still on user-controlled server).
- **User explicitly requests "no audio sync, transcripts only"** as a privacy posture change: the per-device toggle alternative is revisitable.
