import type { AuthorDto, WorkListItemDto } from "@whetstone/contracts";

export type AuthorWorks = Readonly<{
  author: AuthorDto;
  works: ReadonlyArray<WorkListItemDto>;
}>;

// Group the flat works list by Author/Source for the library home, preserving the order
// in which each author first appears and the order of works within each author.
export function groupWorksByAuthor(
  works: ReadonlyArray<WorkListItemDto>
): ReadonlyArray<AuthorWorks> {
  const order: string[] = [];
  const groups = new Map<string, { author: AuthorDto; works: WorkListItemDto[] }>();

  for (const item of works) {
    const existing = groups.get(item.author.id);

    if (existing === undefined) {
      order.push(item.author.id);
      groups.set(item.author.id, { author: item.author, works: [item] });
    } else {
      existing.works.push(item);
    }
  }

  return order.map((id) => {
    const group = groups.get(id) as { author: AuthorDto; works: WorkListItemDto[] };

    return { author: group.author, works: group.works };
  });
}
