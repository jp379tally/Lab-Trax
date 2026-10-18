import type { ReactNode } from "react";
import { AuthedImage, AuthedVideo } from "@/components/AuthedMedia";
import { apiUrl } from "@/lib/api";

export interface MessengerMessage {
  id: string;
  threadId: string;
  senderUserId: string;
  body: string;
  formattingJson: { fontFamily?: string; color?: string } | null;
  mediaKey: string | null;
  mimeType: string | null;
  createdAt: string;
}

interface MessengerBubbleProps {
  message: MessengerMessage;
  isMine: boolean;
  /** Pass true to show a muted "Sending…" state for optimistic messages */
  isPending?: boolean;
  /** When set, occurrences of this text inside the message body are highlighted (search mode). */
  highlightQuery?: string;
  /** Show only for the sender's latest confirmed message once the other side has read it. */
  seen?: boolean;
}

/**
 * Splits `text` on occurrences of `query` (case-insensitive) and wraps each
 * match in a <mark> so search results are visually highlighted in the bubble.
 */
export function highlightText(text: string, query: string | undefined): ReactNode {
  const trimmed = query?.trim();
  if (!trimmed) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  const lowerQuery = trimmed.toLowerCase();
  return parts.map((part, i) =>
    part.toLowerCase() === lowerQuery ? (
      <mark
        key={i}
        className="bg-yellow-200 text-foreground rounded-sm px-0.5 dark:bg-yellow-500/40"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function formatTimestamp(isoStr: string): string {
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  // Same day: show time only
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // Otherwise: date + time
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

const FONT_FAMILY_MAP: Record<string, string> = {
  "sans-serif": "system-ui, sans-serif",
  serif: "Georgia, serif",
  monospace: "ui-monospace, monospace",
};

export function MessengerBubble({ message, isMine, isPending, highlightQuery, seen }: MessengerBubbleProps) {
  const fmt = message.formattingJson;
  const fontFamily = fmt?.fontFamily ? (FONT_FAMILY_MAP[fmt.fontFamily] ?? "inherit") : "inherit";
  const color = fmt?.color ?? undefined;

  const mediaUrl = message.mediaKey
    ? apiUrl(`/provider-messenger/thread/${message.threadId}/messages/${message.id}/media`)
    : null;

  const isImage =
    message.mimeType?.startsWith("image/") ?? false;
  const isVideo =
    message.mimeType?.startsWith("video/") ?? false;

  return (
    <div
      className={`flex flex-col gap-0.5 ${isMine ? "items-end" : "items-start"}`}
    >
      <div
        className={`max-w-[70%] min-w-0 rounded-2xl px-3.5 py-2.5 text-sm shadow-sm ${
          isMine
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm"
        } ${isPending ? "opacity-60" : ""}`}
        style={{ fontFamily, color }}
      >
        {/* Media attachment */}
        {mediaUrl && isImage && (
          <div className="mb-2 rounded-lg overflow-hidden max-w-[260px]">
            <AuthedImage
              url={mediaUrl}
              alt="Attachment"
              className="w-full h-auto object-cover rounded-lg"
            />
          </div>
        )}
        {mediaUrl && isVideo && (
          <div className="mb-2 rounded-lg overflow-hidden max-w-[260px]">
            <AuthedVideo
              url={mediaUrl}
              mimeType={message.mimeType ?? undefined}
              controls
              className="w-full rounded-lg"
            />
          </div>
        )}
        {/* Text body */}
        {message.body && (
          <span className="whitespace-pre-wrap break-words leading-relaxed">
            {highlightText(message.body, highlightQuery)}
          </span>
        )}
      </div>
      <span
        className={`text-[10px] text-muted-foreground/60 px-1 ${
          isMine ? "text-right" : "text-left"
        }`}
      >
        {isPending ? "Sending…" : formatTimestamp(message.createdAt)}
      </span>
      {isMine && seen && !isPending && (
        <span
          className="text-[10px] text-muted-foreground/50 px-1 text-right"
          data-testid="messenger-seen-indicator"
        >
          Seen
        </span>
      )}
    </div>
  );
}
