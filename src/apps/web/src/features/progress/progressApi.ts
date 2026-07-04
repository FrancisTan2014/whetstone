import type { ProgressMapDto } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export async function fetchProgressMap(): Promise<ProgressMapDto> {
  return requestJson<ProgressMapDto>(apiUrl("/progress-map"));
}
