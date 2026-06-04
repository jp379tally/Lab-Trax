import { useEffect, useMemo, useRef, useState } from "react";
import { Box } from "lucide-react";
import {
  arrayBufferToBase64,
  buildThumbnailHtml,
  type ScanFormat,
} from "@workspace/scan-viewer";
import { authedMediaFetch } from "@/lib/api";

interface ScanThumbnailProps {
  cacheKey: string;
  fileUrl: string;
  format: ScanFormat;
  authToken?: string | null;
  /** Displayed size in CSS pixels. Default 44. */
  size?: number;
  /** Optional rounded class — caller can override. */
  className?: string;
}

type Status = "idle" | "loading" | "ready" | "error";

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
): Promise<string> {
  const cached = thumbCache.get(cacheKey);
  if (cached) return cached;
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    await acquireSlot();
    try {
      void authToken; // auth (incl. 401 refresh) handled by authedMediaFetch
      const res = await authedMediaFetch(fileUrl);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buffer = await res.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const html = buildThumbnailHtml(base64, format, { size });

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
  size = 44,
  className,
}: ScanThumbnailProps) {
  const initial = useMemo<Status>(() => {
    if (thumbCache.has(cacheKey)) return "ready";
    if (failed.has(cacheKey)) return "error";
    return "loading";
  }, [cacheKey]);
  const [status, setStatus] = useState<Status>(initial);
  const [dataUrl, setDataUrl] = useState<string | null>(
    () => thumbCache.get(cacheKey) ?? null,
  );
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    if (thumbCache.has(cacheKey)) {
      setDataUrl(thumbCache.get(cacheKey)!);
      setStatus("ready");
      return;
    }
    if (failed.has(cacheKey)) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    fetchAndRender(cacheKey, fileUrl, format, authToken, Math.max(64, size * 2))
      .then((url) => {
        if (cancelled.current) return;
        setDataUrl(url);
        setStatus("ready");
      })
      .catch(() => {
        failed.add(cacheKey);
        if (cancelled.current) return;
        setStatus("error");
      });
    return () => {
      cancelled.current = true;
    };
  }, [cacheKey, fileUrl, format, authToken, size]);

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
