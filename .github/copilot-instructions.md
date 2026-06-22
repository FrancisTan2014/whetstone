# Copilot instructions for whetstone

This repository is built through a design -> issue -> implementation -> review loop.

## Workflow

- Treat `PRODUCT.md` as the durable product/design memory.
- Treat `REVIEW_SPEC.md` as the durable review checklist.
- Treat GitHub issues as the source of truth for implementation work.
- Only implement issues with clear acceptance criteria.
- Keep issues and PRs small. Split broad work before implementation.
- Keep changes scoped to the issue. Do not add extra features, frameworks, or large refactors.
- Open a pull request for completed work and link the issue it resolves.
- Do not merge pull requests from automated or local agent runs.

## Implementation expectations

- Prefer simple, maintainable code over speculative architecture.
- Add or update tests for behavior changes when test infrastructure exists.
- Run the repository's existing build, lint, and test commands before finishing.
- If no build or test command exists yet, state that clearly in the pull request.
- Do not commit secrets, tokens, or machine-specific paths.

## Product direction

Start from the simplest v0 product:

- Admin pages input source reading materials.
- Reader pages display materials.
- Users click or tap words/phrases in the reader to create notes linked to that source text.

Do not reintroduce older complex scope unless a later issue explicitly asks for it.
