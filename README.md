# whetstone

A simple personal reading app, starting from a sharp v0:

1. Admin pages input source reading materials.
2. Reader pages display materials.
3. Users click or tap words/phrases to create notes linked to the source text.

## Development workflow

1. Stabilize a requirement in discussion.
2. Create a GitHub issue with acceptance criteria.
3. Let the scheduled local Copilot developer session claim the issue, delegate implementation to a subagent when available, and open a PR.
4. Let the scheduled local Copilot reviewer session delegate detailed review to a subagent when available and post PR feedback.
5. Iterate, then merge when ready.

See [docs/LOCAL_AGENT_WORKFLOW.md](./docs/LOCAL_AGENT_WORKFLOW.md).

## Local launchers

```powershell
.\scripts\start-design.cmd
.\scripts\start-developer.cmd
.\scripts\start-reviewer.cmd
```

Start scheduled Copilot sessions:

```powershell
.\scripts\start-developer.cmd
.\scripts\start-reviewer.cmd
```
