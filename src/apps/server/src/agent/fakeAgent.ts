import { AgentError } from "./agentFailure.js";
import type { Agent, AgentSession, AgentTurn } from "./agentSession.js";

// A deterministic Agent with no process, no network, and no model, so callers and the `pnpm validate`
// gate exercise a whole conversation without any agent CLI being installed (the same job
// `fakeSpeechInput.ts` does for the voice seam). The caller scripts what each turn answers — either one
// fixed reply, or a function of the prompt for per-turn scripting.
export type ScriptedTurn = string | ((prompt: string) => string);

export function createFakeAgent(scripted: ScriptedTurn): Agent {
  return Object.freeze({
    // The session config is inert here: the fake has no model to steer, so standing instructions
    // change nothing. A test that needs to assert what the provider actually received drives the CLI
    // adapter with an injected process boundary instead.
    open(): Promise<AgentSession> {
      let closed = false;
      // The fake enforces the port's own closed-session rule, so a caller cannot pass its tests against
      // a double that is more permissive than the real adapter.
      return Promise.resolve(
        Object.freeze({
          close(): Promise<void> {
            closed = true;
            return Promise.resolve();
          },
          send(prompt: string): Promise<AgentTurn> {
            return closed
              ? Promise.reject(
                  new AgentError(
                    "agent_session_closed",
                    "The fake agent session is closed; open a new session to keep talking."
                  )
                )
              : Promise.resolve({
                  text: typeof scripted === "function" ? scripted(prompt) : scripted
                });
          }
        })
      );
    }
  });
}
