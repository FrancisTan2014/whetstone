# Review spec

This is the concrete review checklist for whetstone pull requests. The reviewer agent must use this document instead of relying only on generic LLM review instincts.

## Review order

Stop at the first hard blocker if it makes further review noisy. Otherwise leave only material findings.

## 1. Issue fit

- PR links an issue with `Closes #...` or clearly references the issue.
- The linked issue has outcome, acceptance criteria, constraints/non-goals, and validation.
- The PR satisfies all acceptance criteria.
- The PR does not implement requirements outside the linked issue.
- If the issue was too broad, comment that future work must be split; do not reward oversized PRs.

## 2. Product/design fit

- Behavior matches `PRODUCT.md`.
- No older/deferred complexity is reintroduced unless the issue explicitly asked for it.
- v0 stays focused on: admin content input, continuous reader, selected text note capture, Entry/link model, DB-backed note templates.
- No hidden feature creep: no spaced repetition, memorization scheduling, AI grading, voice, ebook parsing, or complicated settings in v0.

## 3. Architecture fit

- Web-core TypeScript direction is preserved.
- Server-centered source of truth is preserved.
- Server stores Markdown files under a data directory; PostgreSQL stores metadata, paths, indexes, templates, notes, and links.
- Entry/link model is preserved; notes are entries, not ad-hoc child records that cannot participate in future links.
- Note anchors store reading-unit entry id, start/end offsets, selected text snapshot, and containing paragraph/context snapshot.
- Templates are read from DB seed data, not hard-coded in UI components.
- Template definitions use controlled JSON (`fields_json`), and note answers use `answers_json`.

## 4. Data safety

- No secrets, tokens, passwords, local machine paths, or personal content are committed.
- File paths for server-side Markdown are normalized and cannot escape the configured data directory.
- User-provided Markdown/text is rendered safely; no unsafe HTML injection.
- Database migrations, seed data, and file writes are deterministic and repeatable.

## 5. Code quality

- TypeScript is strict.
- No unnecessary `any`.
- No broad silent catches or success-shaped fallbacks.
- Functions/components are named for their responsibility.
- The PR uses existing patterns in the repo.
- No large speculative abstractions or framework additions outside the issue.

## 6. Validation

- PR body lists the commands run.
- Existing build/lint/test commands pass.
- If validation cannot run because tooling does not exist yet, the PR says so and the issue scope justifies it.
- Behavior changed by the PR has tests when test infrastructure exists.

## 7. Review output

Use one of:

- **Request changes**: material issue blocks merge. Add label `changes-requested`, remove `needs-review`.
- **Ready for human merge**: no material blockers. Add label `review-approved`, remove `needs-review` and `changes-requested`.

Every review must include marker:

```text
reviewer-run-reviewed: <head-sha>
```
