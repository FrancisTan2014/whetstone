# Copilot instructions for whetstone

This repository is built through a design -> issue -> implementation -> CI merge loop owned by one
delivery agent.

## Workflow

- Treat `PRODUCT.md` as the durable product/design memory.
- Treat `GUIDELINES.md` as the durable engineering and review guide.
- Treat GitHub issues as the source of truth for implementation work.
- There is no scheduled automation. The human maintainer triggers one developer agent, which owns
  design and implementation for one unit of work.
- Only implement issues with clear acceptance criteria.
- Keep issues and PRs small. Split broad work before implementation.
- Keep changes scoped to the issue. Do not add extra features, frameworks, or large refactors.
- Open a pull request for completed work and link the issue it resolves.
- The developer agent never merges by hand. It applies `merge-ready` after its acceptance self-check;
  a deterministic merge step merges only when every `GUIDELINES.md` CI and repository gate passes.

## Implementation expectations

- Prefer simple, maintainable code over speculative architecture.
- Follow `GUIDELINES.md`; do not invent a different project structure.
- Add or update tests for behavior changes when test infrastructure exists.
- Run `pnpm validate` (typecheck, lint, test, build) before finishing.
- If a command does not exist yet, state that clearly in the pull request.
- Do not commit secrets, tokens, or machine-specific paths.
- Engineering standards and the validation gate are operationalized by the `whetstone-engineering` skill in `.github/skills/`; `GUIDELINES.md` and `PRODUCT.md` remain the source of truth.

## Product direction

Whetstone is a private, deterministic personal learning assistant:

- The learner chooses what matters; Whetstone remembers, schedules, presents, and records it.
- The complete product must work with every AI/model integration disabled.
- Recitation with FSRS is the reference daily routine, alongside reading, Memory, diary, and writing.
- Today shows explicit routines and deterministic due work, never unsolicited proposals.
- Model-backed diary tidy and contextual explanation may remain only as optional, non-blocking
  utilities over an already-saved deterministic result.

Do not reintroduce the autonomous coach, generated cases, Progress Map, reading nudges, or other
proposal-led scope unless a later product decision explicitly restores it.
