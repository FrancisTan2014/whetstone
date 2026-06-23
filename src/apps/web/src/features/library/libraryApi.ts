import type {
  AuthorDto,
  AuthorListDto,
  CreateAuthorRequest,
  CreateWorkRequest,
  WorkListDto,
  WorkListItemDto
} from "@whetstone/contracts";

const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export async function fetchAuthors(): Promise<AuthorListDto> {
  return requestJson<AuthorListDto>("/api/authors");
}

export async function fetchWorks(): Promise<WorkListDto> {
  return requestJson<WorkListDto>("/api/works");
}

export async function createAuthor(request: CreateAuthorRequest): Promise<AuthorDto> {
  return requestJson<AuthorDto>("/api/authors", {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}

export async function createWork(request: CreateWorkRequest): Promise<WorkListItemDto> {
  return requestJson<WorkListItemDto>("/api/works", {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}
