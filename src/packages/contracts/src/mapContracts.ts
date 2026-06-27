import { z } from "zod";

import { caseMasterySummaryDtoSchema, domainDtoSchema } from "./caseContracts.js";
import { errorPatternDtoSchema } from "./learnerContracts.js";

// Shared shapes for the fog-of-war progress map (#210): domains -> cases rendered lit/dim/dark from
// real mastery (#205), plus progress signals (owned/weak counts + error trend from #208) and the
// recommended next region. Visualization over existing data — no new scoring here.

// Mirrors `caseLightLevels` in `@whetstone/domain` (`progressMap.ts`).
export const caseLightLevels = ["lit", "dim", "dark"] as const;

export const caseLightLevelSchema = z.enum(caseLightLevels);

export type CaseLightLevel = z.infer<typeof caseLightLevelSchema>;

// One case on the map: its light level, the mastery summary it was derived from, and whether it is the
// coach's recommended next region.
export const mapCaseDtoSchema = z
  .object({
    caseId: z.string(),
    communicativeFunction: z.string(),
    light: caseLightLevelSchema,
    mastery: caseMasterySummaryDtoSchema,
    recommended: z.boolean(),
    situation: z.string()
  })
  .strict();

export type MapCaseDto = z.infer<typeof mapCaseDtoSchema>;

export const mapDomainDtoSchema = z
  .object({
    cases: z.array(mapCaseDtoSchema),
    domain: domainDtoSchema
  })
  .strict();

export type MapDomainDto = z.infer<typeof mapDomainDtoSchema>;

// The progress signals: owned vs weak chunk counts, the recurring-error trend (#208), and a
// plain-language summary — the motivation engine, not XP.
export const progressSignalsDtoSchema = z
  .object({
    errorTrend: z.array(errorPatternDtoSchema),
    ownedChunks: z.number().int(),
    summary: z.string(),
    totalChunks: z.number().int(),
    weakChunks: z.number().int()
  })
  .strict();

export type ProgressSignalsDto = z.infer<typeof progressSignalsDtoSchema>;

export const progressMapDtoSchema = z
  .object({
    domains: z.array(mapDomainDtoSchema),
    recommendedCaseId: z.string().nullable(),
    signals: progressSignalsDtoSchema
  })
  .strict();

export type ProgressMapDto = z.infer<typeof progressMapDtoSchema>;

export function parseProgressMapDto(value: unknown): ProgressMapDto {
  return progressMapDtoSchema.parse(value);
}
