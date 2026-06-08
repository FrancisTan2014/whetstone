# Daily routine algorithm

> 🚧 **Placeholder** — to be filled in during Task #5 (Design daily routine algorithm).

The function signature, roughly:

```csharp
DailyRoutine GenerateRoutine(
    DateOnly today,
    IReadOnlyList<Note> allNotes,
    RoutineConfig config // cap, ritual list, subject weights
);
```

Returned routine contains:

- **Recall items** (≤ cap, prioritized by `days_overdue desc, ease asc`)
- **Deferred overflow** (notes whose `next_review` was today but didn't make the cap — `next_review` pushed +1 day)
- **New-input slots** per active subject (sized by daily time budget — see [user_learning_goals](../../README.md))
- **Ritual slot** for 《笠翁对韵》 — outside SRS, always present, just a checkbox

Open questions for Task #5:
- How does the algorithm handle a day with zero recall items? (early days, before SRS warms up)
- How are new-input slots chosen — round-robin across subjects, or weighted?
- How does the user mark a new-input slot as "done" (creates a note? checkbox?)
- What's the smallest reasonable cap before the loop feels too quiet?
