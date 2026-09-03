// The local agent seam (#904): the one boundary Whetstone talks to a locally installed agentic CLI
// through — Qwen Code, Gemini CLI, Claude Code, GitHub Copilot CLI, or any other. It is the agent-level
// twin of the `SpeechInput` voice seam: a caller depends only on THIS port, never on which tool is
// installed, so swapping the underlying CLI cannot fork a product flow. A session is a conversation:
// `open` starts one, `send` takes one turn in it, `close` ends it.
//
// Nothing in the product calls this yet — the seam is delivered as an independent component and wired
// by a later issue that makes the product decision. It is also deliberately CLOSED: no tool is granted
// to the agent here, so a provider cannot reach Whetstone's data (in particular, there is no alternate
// FSRS writer) until an issue adds the first tool by name.

// One assistant turn. Transcript-first, exactly like the speech seam's transcript: `text` is the whole
// required payload, so a provider that reports nothing else is still a valid, complete answer.
export type AgentTurn = Readonly<{
  text: string;
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
