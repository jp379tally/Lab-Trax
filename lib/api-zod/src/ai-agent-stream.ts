/** Wire contract for the LabTrax Assistant agent SSE endpoint. */
export type AiAgentProgressPhase =
  | "context"
  | "model"
  | "tool"
  | "response";

export type AiAgentStreamEvent =
  | { progress: { phase: AiAgentProgressPhase; message: string } }
  | { token: string }
  | { tool_call: { name: string } }
  | {
      proposed_action: {
        actionId: string;
        toolName: string;
        summary: string;
        args: Record<string, unknown>;
      };
    }
  | {
      done: true;
      toolOutputs?: Array<{ name: string; result: unknown }>;
      knowledgeSectionIds?: string[];
      retentionDisclaimer?: boolean;
      disclaimer?: string;
      privacyDisclaimer?: boolean;
    }
  | { error: string };