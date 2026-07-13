// Configuration for the optional local AI utilities (#602): diary "tidy" and the Reader "AI 解释"
// contextual gloss. Both are absent-config-safe and independent of the (retiring) coach — each reads
// its OWN model env var here, in the generic `llm` boundary, instead of borrowing the coach's model,
// adapters, or tiers. With no variable set the utility is simply off (diary tidy returns the faithful
// transcript; the explanation aid stays "unavailable"), so the base install needs no model.

// Diary tidy's local model, or undefined when unset (tidy then returns the faithful transcript). The
// model to use is `DIARY_TIDY_MODEL`. `COACH_MODEL` is honored as a documented one-release, read-only
// alias so an existing fully-local coach install keeps tidying without editing `.env`; newly written
// config uses `DIARY_TIDY_MODEL`. A blank value (either var) is treated as unset.
export type DiaryTidyConfig = Readonly<{ modelName: string | undefined }>;

function cleanModelName(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim().length === 0 ? undefined : raw.trim();
}

export function readDiaryTidyConfig(env: NodeJS.ProcessEnv = process.env): DiaryTidyConfig {
  const modelName = cleanModelName(env.DIARY_TIDY_MODEL) ?? cleanModelName(env.COACH_MODEL);

  return { modelName };
}
