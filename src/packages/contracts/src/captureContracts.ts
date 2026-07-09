import { z } from "zod";

export const captureLanguages = ["zh", "en"] as const;

export const captureLanguageSchema = z.string().trim().pipe(z.enum(captureLanguages));

export type CaptureLanguage = z.infer<typeof captureLanguageSchema>;
