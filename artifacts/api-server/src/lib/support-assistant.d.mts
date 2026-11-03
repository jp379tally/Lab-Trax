export class SupportError extends Error { statusCode: number; constructor(statusCode: number, message: string); }
export const FAQ: Array<{ id: string; title: string; url: string; text: string }>;
export function validateSupportMessage(body: unknown): string;
export function answerSupport(options: {
  client: import("openai").default | null;
  message: string;
  scope?: import("./support-assistant-data").SupportScope | null;
  lookup?: typeof import("./support-assistant-data").lookupSupportData;
  model?: string;
  signal?: AbortSignal;
}): Promise<{ reply: string; mode: "account" | "public"; sources: Array<{ title: string; url: string }>; checkedAt: string }>;
