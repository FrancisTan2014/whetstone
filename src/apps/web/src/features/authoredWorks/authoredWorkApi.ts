import type {
  AuthoredWorkDto,
  AuthoredWorkListDto,
  ContinueWritingDto,
  CreateAuthoredWorkRequest
} from "@whetstone/contracts";
import {
  parseAuthoredWorkDto,
  parseAuthoredWorkListDto,
  parseContinueWritingDto
} from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { apiUrl } from "../../shared/runtime";

// The authored-Works API client (#576): every response is parsed through the shared contracts at the
// boundary before the feature trusts it, mirroring the diary/library clients. `apiUrl` supplies the
// host base, so no path hardcodes `/api`.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson<T>(
  path: string,
  init: RequestInit | undefined,
  parse: (value: unknown) => T
): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return parse(await response.json());
}

// Create an owned Work with an empty document; the server returns it ready for the editor to open.
export async function createAuthoredWork(
  request: CreateAuthoredWorkRequest
): Promise<AuthoredWorkDto> {
  return requestJson(
    apiUrl("/authored-works"),
    { body: JSON.stringify(request), headers: jsonHeaders, method: "POST" },
    parseAuthoredWorkDto
  );
}

// Load one authored Work with its reassembled canonical document, for editing or reading.
export async function fetchAuthoredWork(workEntryId: string): Promise<AuthoredWorkDto> {
  return requestJson(
    apiUrl(`/authored-works/${encodeURIComponent(workEntryId)}`),
    undefined,
    parseAuthoredWorkDto
  );
}

// Save an authored Work's document (autosave / explicit save): latest-write-safe, id-preserving replace.
// Resolves with the persisted Work only after the server has stored it.
export async function saveAuthoredWorkContent(
  workEntryId: string,
  document: DocumentNodeJSON
): Promise<AuthoredWorkDto> {
  return requestJson(
    apiUrl(`/authored-works/${encodeURIComponent(workEntryId)}/content`),
    { body: JSON.stringify({ document }), headers: jsonHeaders, method: "PUT" },
    parseAuthoredWorkDto
  );
}

// The current user's authored Works (summaries, newest edit first) so the Library can badge owned drafts
// and route them to the editor.
export async function listAuthoredWorks(): Promise<AuthoredWorkListDto> {
  return requestJson(apiUrl("/authored-works"), undefined, parseAuthoredWorkListDto);
}

// Today's "Continue writing" target: the most recently edited authored Work, or null when there is none.
export async function fetchContinueWriting(): Promise<ContinueWritingDto> {
  return requestJson(apiUrl("/authored-works/continue"), undefined, parseContinueWritingDto);
}
