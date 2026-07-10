import { z } from "zod";

export const captureLanguages = ["zh", "en"] as const;

export const captureLanguageSchema = z.string().trim().pipe(z.enum(captureLanguages));

export type CaptureLanguage = z.infer<typeof captureLanguageSchema>;

// How a capture was entered: a `typed` text box or a `voice` tap-and-talk clip. Shared across the diary
// capture and voice-capture contracts so a persisted Entry records how it was made.
export const captureInputModes = ["typed", "voice"] as const;

export const captureInputModeSchema = z.enum(captureInputModes);

export type CaptureInputMode = z.infer<typeof captureInputModeSchema>;
