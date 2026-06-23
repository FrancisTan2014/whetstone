# Copilot instructions for whetstone

This repository is built through a design -> issue -> implementation -> review loop.

## Workflow

- Treat `PRODUCT.md` as the durable product/design memory.
- Treat `GUIDELINES.md` as the durable engineering and review guide.
- Treat GitHub issues as the source of truth for implementation work.
- There is no scheduled automation. The human maintainer is the coordinator and manually triggers the developer and reviewer roles, one unit of work at a time.
- Only implement issues with clear acceptance criteria.
- Keep issues and PRs small. Split broad work before implementation.
- Keep changes scoped to the issue. Do not add extra features, frameworks, or large refactors.
- Open a pull request for completed work and link the issue it resolves.
- Developer agents do not merge pull requests. Reviewer agents may merge only when `GUIDELINES.md` merge gates are satisfied.

## Implementation expectations

- Prefer simple, maintainable code over speculative architecture.
- Follow `GUIDELINES.md`; do not invent a different project structure.
- Add or update tests for behavior changes when test infrastructure exists.
- Run `pnpm validate` (typecheck, lint, test, build) before finishing.
- If a command does not exist yet, state that clearly in the pull request.
- Do not commit secrets, tokens, or machine-specific paths.
- Engineering standards and the validation gate are operationalized by the `whetstone-engineering` skill in `.github/skills/`; `GUIDELINES.md` and `PRODUCT.md` remain the source of truth.

## Product direction

Start from the simplest v0 product:

- Admin pages input source reading materials.
- Reader pages display materials.
- Users click or tap words/phrases in the reader to create notes linked to that source text.

Do not reintroduce older complex scope unless a later issue explicitly asks for it.
