import {
  useRef,
  useState,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { Smile, Paperclip, Send, X, Type, Palette } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface FormattingJson {
  fontFamily?: string;
  color?: string;
}

interface MessengerComposerProps {
  onSend: (text: string, formatting: FormattingJson, file: File | null) => Promise<void> | void;
  disabled?: boolean;
  placeholder?: string;
}

const FONT_OPTIONS = [
  { value: "sans-serif", label: "Sans-serif" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Mono" },
];

const FONT_FAMILY_MAP: Record<string, string> = {
  "sans-serif": "system-ui, sans-serif",
  serif: "Georgia, serif",
  monospace: "ui-monospace, monospace",
};

const COLOR_SWATCHES = [
  { value: "default", label: "Default", bg: "transparent", border: "#d1d5db" },
  { value: "#ef4444", label: "Red", bg: "#ef4444" },
  { value: "#f97316", label: "Orange", bg: "#f97316" },
  { value: "#eab308", label: "Yellow", bg: "#eab308" },
  { value: "#22c55e", label: "Green", bg: "#22c55e" },
  { value: "#3b82f6", label: "Blue", bg: "#3b82f6" },
  { value: "#8b5cf6", label: "Purple", bg: "#8b5cf6" },
  { value: "#ec4899", label: "Pink", bg: "#ec4899" },
  { value: "#6b7280", label: "Grey", bg: "#6b7280" },
  { value: "#1a1a1a", label: "Dark", bg: "#1a1a1a" },
];

export function MessengerComposer({
  onSend,
  disabled = false,
  placeholder = "Type a message…",
}: MessengerComposerProps) {
  const [text, setText] = useState("");
  const [fontFamily, setFontFamily] = useState("sans-serif");
  const [color, setColor] = useState("default");
  const [file, setFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [fontOpen, setFontOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSend = (text.trim().length > 0 || file !== null) && !disabled && !sending;

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxH = 5 * 24; // ~5 lines
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  }

  function handleTextChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    autoResize();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void doSend();
    }
  }

  function handleEmojiSelect(emoji: { native?: string }) {
    if (!emoji.native) return;
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      const next = text.slice(0, start) + emoji.native + text.slice(end);
      setText(next);
      // Restore cursor after inserted emoji
      setTimeout(() => {
        const pos = start + emoji.native!.length;
        el.selectionStart = pos;
        el.selectionEnd = pos;
        el.focus();
        autoResize();
      }, 0);
    } else {
      setText((prev) => prev + emoji.native);
    }
    setEmojiOpen(false);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setFilePreviewUrl(f ? URL.createObjectURL(f) : null);
    // Reset input so same file can be re-picked
    e.target.value = "";
  }

  function removeFile() {
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setFile(null);
    setFilePreviewUrl(null);
  }

  const doSend = useCallback(async () => {
    if (!canSend) return;
    // Capture current values before any state mutation
    const msgText = text.trim();
    const fmt: FormattingJson = {};
    if (fontFamily !== "sans-serif") fmt.fontFamily = fontFamily;
    if (color !== "default") fmt.color = color;
    const attachedFile = file;
    const attachedPreviewUrl = filePreviewUrl;

    // Clear the UI optimistically — we restore on failure
    setText("");
    setFile(null);
    setFilePreviewUrl(null); // keep the object URL alive until success/failure
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setSendError(null);
    setSending(true);

    try {
      await onSend(msgText, fmt, attachedFile);
      // Only revoke the object URL after a confirmed send
      if (attachedPreviewUrl) URL.revokeObjectURL(attachedPreviewUrl);
    } catch {
      // Restore draft so the user doesn't lose their work
      setText(msgText);
      setFile(attachedFile);
      setFilePreviewUrl(attachedPreviewUrl); // restore the still-valid object URL
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        // Let autoResize recalculate on the next render
        setTimeout(autoResize, 0);
      }
      setSendError("Failed to send. Please try again.");
    } finally {
      setSending(false);
    }
  }, [canSend, text, fontFamily, color, file, filePreviewUrl, onSend]);

  const currentFontLabel = FONT_OPTIONS.find((f) => f.value === fontFamily)?.label ?? "Sans";
  const currentColorSwatch = COLOR_SWATCHES.find((c) => c.value === color);
  const activeColor = color === "default" ? undefined : color;
  const activeFontFamily = FONT_FAMILY_MAP[fontFamily] ?? "inherit";

  return (
    <div className="border-t border-border bg-background">
      {/* Send error banner */}
      {sendError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-3 py-1.5 bg-destructive/10 text-destructive text-xs"
        >
          <span>{sendError}</span>
          <button
            type="button"
            onClick={() => setSendError(null)}
            className="shrink-0 underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Attachment preview strip */}
      {file && filePreviewUrl && (
        <div className="flex items-center gap-2 px-3 pt-2">
          <div className="relative inline-block">
            {file.type.startsWith("image/") ? (
              <img
                src={filePreviewUrl}
                alt={file.name}
                className="h-16 w-16 object-cover rounded-lg border border-border"
              />
            ) : file.type.startsWith("video/") ? (
              <video
                src={filePreviewUrl}
                className="h-16 w-24 object-cover rounded-lg border border-border"
                muted
              />
            ) : (
              <div className="h-16 w-24 flex items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground truncate px-1">
                {file.name}
              </div>
            )}
            <button
              type="button"
              onClick={removeFile}
              className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow"
              aria-label="Remove attachment"
            >
              <X size={11} />
            </button>
          </div>
          <span className="text-xs text-muted-foreground truncate max-w-[180px]">
            {file.name}
          </span>
        </div>
      )}

      {/* Composer row */}
      <div className="flex items-end gap-1 px-2 py-2">
        {/* Emoji picker */}
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Emoji"
              disabled={disabled}
            >
              <Smile size={17} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="p-0 border-0 shadow-xl w-auto"
            sideOffset={4}
          >
            <Picker
              data={data}
              onEmojiSelect={handleEmojiSelect}
              theme="light"
              previewPosition="none"
              skinTonePosition="none"
            />
          </PopoverContent>
        </Popover>

        {/* Font picker */}
        <Popover open={fontOpen} onOpenChange={setFontOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 h-8 px-1.5 flex items-center gap-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-xs"
              aria-label="Font"
              disabled={disabled}
            >
              <Type size={14} />
              <span>{currentFontLabel}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-36 p-1" sideOffset={4}>
            {FONT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => { setFontFamily(opt.value); setFontOpen(false); }}
                className={`w-full text-left px-2.5 py-1.5 rounded-sm text-sm transition-colors ${
                  fontFamily === opt.value
                    ? "bg-primary/10 text-primary font-medium"
                    : "hover:bg-muted"
                }`}
                style={{ fontFamily: FONT_FAMILY_MAP[opt.value] }}
              >
                {opt.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        {/* Color picker */}
        <Popover open={colorOpen} onOpenChange={setColorOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Text color"
              disabled={disabled}
            >
              <Palette size={17} style={{ color: activeColor }} />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-auto p-2" sideOffset={4}>
            <div className="grid grid-cols-5 gap-1.5">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch.value}
                  type="button"
                  onClick={() => { setColor(swatch.value); setColorOpen(false); }}
                  title={swatch.label}
                  className={`h-6 w-6 rounded-full transition-transform hover:scale-110 ${
                    color === swatch.value ? "ring-2 ring-offset-1 ring-primary scale-110" : ""
                  }`}
                  style={{
                    background: swatch.bg,
                    border: `1.5px solid ${swatch.border ?? swatch.bg}`,
                  }}
                  aria-label={swatch.label}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Attachment */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Attach file"
          disabled={disabled}
        >
          <Paperclip size={17} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Message input"
          rows={1}
          disabled={disabled || sending}
          className="flex-1 min-w-0 resize-none rounded-2xl border border-border bg-muted/30 px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 placeholder:text-muted-foreground/60 leading-6 overflow-y-auto"
          style={{
            fontFamily: activeFontFamily,
            color: activeColor,
            maxHeight: `${5 * 24}px`,
          }}
        />

        {/* Send button */}
        <button
          type="button"
          onClick={() => void doSend()}
          disabled={!canSend}
          className="shrink-0 h-8 w-8 flex items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
          aria-label="Send"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
