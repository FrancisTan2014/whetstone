# Daily routine algorithm

> 🚧 **Placeholder, superseded in part** — original sketch assumed a single SM-2 queue with one daily cap. The methodology pivot (see [`06-methodology.md`](./06-methodology.md) and [ADR 0003](./decisions/0003-learning-methodology.md)) splits recall into per-category algorithms with interleaving. To be re-drafted during Task #5.

The function signature, roughly:

```csharp
DailyRoutine GenerateRoutine(
    DateOnly today,
    IReadOnlyList<Note> allNotes,
    IReadOnlyList<Category> categories,
    RoutineConfig config // cap, ritual list, category weights
);
```

Returned routine contains:

- **Recall items** (≤ cap, interleaved across categories with eligible items per round-robin)
- **Deferred overflow** (items whose due date was today but didn't make the cap — next-surface pushed +1 day)
- **New-encounter slots** per active category (sized by category weight × available time)
- **Ritual slot** for daily reading — outside any recall queue, always present, just a checkbox

Open questions for Task #5:
- Round-robin ordering: alphabetical by category? Weighted by user's per-category weight?
- How does the algorithm handle a day with zero recall items? (early days, before any category has accumulated due items)
- How does the user mark a new-encounter slot as "done" (creates a note? checkbox?)
- What's the smallest reasonable cap before the loop feels too quiet?
- How does linked-surfacing (concept/mechanism) interact with the daily cap?
