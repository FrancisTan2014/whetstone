// The local agent seam (#904): the one boundary Whetstone talks to a locally installed agentic CLI
// through — Qwen Code, Gemini CLI, Claude Code, GitHub Copilot CLI, or any other. It is the agent-level
// twin of the `SpeechInput` voice seam: a caller depends only on THIS port, never on which tool is
// installed, so swapping the underlying CLI cannot fork a product flow. A session is a conversation:
// `open` starts one, `send` takes one turn in it, `close` ends it.
//
// The port is deliberately CLOSED: product clients supply the permitted content, rather than granting
// the agent access to Whetstone's data or an alternate FSRS writer.

// One assistant turn. Transcript-first, exactly like the speech seam's transcript: `text` is the whole
// required payload, so a provider that reports nothing else is still a valid, complete answer.
// Optional model/effort attribution comes from provider evidence, never from requested settings.
export type AgentTurn = Readonly<{
  text: string;
  model?: string;
  reasoningEffort?: string;
}>;

// How a conversation is opened. `instructions` are the standing system instructions for the whole
// session (a persona, a task framing); omitted means the provider's own default behavior.
export type AgentSessionConfig = Readonly<{
  instructions?: string;
}>;

export type AgentSession = Readonly<{
  send(prompt: string): Promise<AgentTurn>;
  close(): Promise<void>;
}>;

export type Agent = Readonly<{
  open(config: AgentSessionConfig): Promise<AgentSession>;
}>;
