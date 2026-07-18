import type { RecitationOverviewDto } from "@whetstone/contracts";
import { parseRecitationOverviewDto } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The Recite home client (#638): the learner's enrolled Works with their live due state and next review
// dates. Parsed through the shared contract at the boundary before the feature trusts it; `apiUrl` supplies
// the host base so no path hardcodes `/api`.
export async function fetchRecitationOverview(): Promise<RecitationOverviewDto> {
  const response = await fetch(apiUrl("/recitation/overview"));

  if (!response.ok) {
    throw new Error(`Request to /recitation/overview failed with status ${response.status}.`);
  }

  return parseRecitationOverviewDto(await response.json());
}
