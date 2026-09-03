"""The Whetstone-owned GitHub Copilot CLI shim.

Installed with pip, this package exposes the `whetstone-copilot` console script: a native launcher that
honours the provider-neutral local agent executable protocol in `docs/AGENT.md` and drives the locally
installed, already-authenticated `copilot` CLI non-interactively. All vendor specifics live here, never
in `src/` — Whetstone's agent seam knows only an executable path and a model identifier.
"""
