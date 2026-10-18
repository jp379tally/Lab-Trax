import { useEffect, useMemo, useRef, useState } from "react";
import { Box } from "lucide-react";
import {
  arrayBufferToBase64,
  buildThumbnailHtml,
  type ScanFormat,
} from "@workspace/scan-viewer";

interface ScanThumbnailProps {
  cacheKey: string;
  fileUrl: string;
  format: ScanFormat;
  authToken?: string | null;
  textureUrl?: string | null;
  pendingTextureCandidates?: PendingTextureCandidate[];
  /** Displayed size in CSS pixels. Default 44. */
  size?: number;
  /** Optional rounded class — caller can override. */
  className?: string;
}

type Status = "idle" | "loading" | "ready" | "error";

export interface PendingTextureCandidate {
  fileName: string;
  fileUrl: string;
  mimeType: string;
}

const MAX_PLY_HEADER_BYTES = 64 * 1024;
const NO_PENDING_TEXTURES: PendingTextureCandidate[] = [];

/** Read the PLY's bounded header; the returned name is data, never a URL. */
export function plyDeclaredTextureFilename(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, MAX_PLY_HEADER_BYTES));
  const header = new TextDecoder("utf-8").decode(bytes);
  const end = header.indexOf("end_header");
  if (end < 0) return null;
  const textureLines = header.slice(0, end).split(/\r?\n/).filter((line) =>
    /^comment\s+TextureFile(?:\s+|$)/i.test(line.trim()),
  );
  if (textureLines.length !== 1) return null;
  const declared = textureLines[0]?.trim().match(/^comment\s+TextureFile\s+(.+?)\s*$/i)?.[1]?.trim();
  return declared && declared.length <= 255 &&
    !/[\u0000-\u001f/:\\]/.test(declared) && !declared.includes("..")
    ? declared
    : null;
}

export function matchPendingPlyTexture(
  buffer: ArrayBuffer,
  candidates: PendingTextureCandidate[],
): PendingTextureCandidate | null {
  const declared = plyDeclaredTextureFilename(buffer);
  if (!declared) return null;
  const matches = candidates.filter((candidate) =>
    candidate.fileName === declared &&
    /^image\/(?:jpeg|jpg|png|webp|bmp|gif|avif)$/i.test(candidate.mimeType),
  );
  return matches.length === 1 ? matches[0]! : null;
}

// Module-level cache so re-mounting the row (or scrolling through a long
// case) doesn't trigger a re-download / re-render of the same scan.
const thumbCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const failed = new Set<string>();

// Cap how many scans we try to fetch+render concurrently so opening a case
// with many .stl attachments doesn't saturate the network or GPU.
const MAX_CONCURRENT = 2;
let active = 0;
const queue: Array<() => void> = [];
function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push(() => {
      active++;
      resolve();
    });
  });
}
function releaseSlot() {
  active = Math.max(0, active - 1);
  const next = queue.shift();
  if (next) next();
}

async function fetchAndRender(
  cacheKey: string,
  fileUrl: string,
  format: ScanFormat,
  authToken: string | null | undefined,
  size: number,
  textureUrl?: string | null,
  pendingTextureCandidates: PendingTextureCandidate[] = [],
): Promise<string> {
  const cached = thumbCache.get(cacheKey);
  if (cached) return cached;
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    await acquireSlot();
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
      const res = await fetch(fileUrl, { headers });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buffer = await res.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      let texture: { base64: string; mimeType: string } | undefined;
      const matchedTexture =
        format === "ply" ? matchPendingPlyTexture(buffer, pendingTextureCandidates) : null;
      const selectedTextureUrl = textureUrl ?? matchedTexture?.fileUrl;
      if (selectedTextureUrl) {
        try {
          const textureRes = await fetch(selectedTextureUrl, { headers });
          if (textureRes.ok) {
            texture = {
              base64: arrayBufferToBase64(await textureRes.arrayBuffer()),
              mimeType:
                textureRes.headers.get("content-type") || matchedTexture?.mimeType || "image/jpeg",
            };
          }
        } catch {
          // A missing texture should still produce a neutral scan thumbnail.
        }
      }
      const html = buildThumbnailHtml(base64, format, { size }, texture);

      const iframe = document.createElement("iframe");
      iframe.style.position = "absolute";
      iframe.style.left = "-99999px";
      iframe.style.top = "0";
      iframe.style.width = `${size}px`;
      iframe.style.height = `${size}px`;
      iframe.style.border = "0";
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("aria-hidden", "true");
      iframe.srcdoc = html;
      document.body.appendChild(iframe);

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error("timeout"));
        }, 30_000);
        function onMessage(e: MessageEvent) {
          if (e.source !== iframe.contentWindow) return;
          if (typeof e.data !== "string") return;
          try {
            const msg = JSON.parse(e.data) as {
              type?: string;
              dataUrl?: string;
            };
            if (msg.type === "thumb" && typeof msg.dataUrl === "string") {
              window.clearTimeout(timer);
              window.removeEventListener("message", onMessage);
              resolve(msg.dataUrl);
            } else if (msg.type === "error") {
              window.clearTimeout(timer);
              window.removeEventListener("message", onMessage);
              reject(new Error("parse_failed"));
            }
          } catch {
            // ignore non-JSON
          }
        }
        window.addEventListener("message", onMessage);
      }).finally(() => {
        // Always tear the iframe down, even on success.
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      });

      thumbCache.set(cacheKey, dataUrl);
      return dataUrl;
    } finally {
      releaseSlot();
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

export default function ScanThumbnail({
  cacheKey,
  fileUrl,
  format,
  authToken,
  textureUrl,
  pendingTextureCandidates = NO_PENDING_TEXTURES,
  size = 44,
  className,
}: ScanThumbnailProps) {
  // Texture relinking must invalidate both successful and failed entries.
  // Include the canonical texture identity rather than caching only by mesh id.
  const cacheIdentity = `${cacheKey}|texture:${textureUrl ?? ""}|pending:${pendingTextureCandidates
    .map((candidate) => `${candidate.fileName}:${candidate.fileUrl}:${candidate.mimeType}`)
    .sort()
    .join(",")}`;
  const initial = useMemo<Status>(() => {
    if (thumbCache.has(cacheIdentity)) return "ready";
    if (failed.has(cacheIdentity)) return "error";
    return "loading";
  }, [cacheIdentity]);
  const [status, setStatus] = useState<Status>(initial);
  const [dataUrl, setDataUrl] = useState<string | null>(
    () => thumbCache.get(cacheIdentity) ?? null,
  );
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    if (thumbCache.has(cacheIdentity)) {
      setDataUrl(thumbCache.get(cacheIdentity)!);
      setStatus("ready");
      return;
    }
    if (failed.has(cacheIdentity)) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    setDataUrl(null);
    fetchAndRender(
      cacheIdentity,
      fileUrl,
      format,
      authToken,
      Math.max(64, size * 2),
      textureUrl,
      pendingTextureCandidates,
    )
      .then((url) => {
        if (cancelled.current) return;
        setDataUrl(url);
        setStatus("ready");
      })
      .catch(() => {
        failed.add(cacheIdentity);
        if (cancelled.current) return;
        setStatus("error");
      });
    return () => {
      cancelled.current = true;
    };
  }, [cacheIdentity, fileUrl, format, authToken, size, textureUrl, pendingTextureCandidates]);

  const baseClass =
    className ??
    "rounded-md border border-border bg-secondary/40 overflow-hidden flex items-center justify-center text-muted-foreground shrink-0";
  const style = { width: size, height: size } as const;

  if (status === "ready" && dataUrl) {
    return (
      <div className={baseClass} style={style}>
        <img
          src={dataUrl}
          alt=""
          width={size}
          height={size}
          className="w-full h-full object-cover"
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div className={baseClass} style={style} aria-hidden="true">
      <Box size={Math.round(size * 0.45)} />
    </div>
  );
}
