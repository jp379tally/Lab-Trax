import { useEffect, useState, type MouseEventHandler, type ReactNode } from "react";
import { X } from "lucide-react";
import { authedMediaFetch, getApiOrigin, waitForTokenHydration } from "@/lib/api";

// True only when `url` is a relative path (always same-origin) or an absolute
// URL whose origin matches our API origin. The bearer token must NEVER be sent
// to a third-party host, so we validate the origin before attaching the
// Authorization header.
//
// Key cases handled:
//   • Relative URLs ("/api/…") — always same-origin; return true.
//   • Absolute URL + empty API origin (web/dev mode, VITE_API_BASE_URL="") —
//     compare against window.location.origin.
//   • Absolute URL + configured API origin (Electron) — compare origins.
export function isSameApiOrigin(url: string): boolean {
  try {
    // Relative URLs have no scheme and always route to the page's own origin.
    if (!url.includes("://")) return true;
    const apiOrigin = getApiOrigin();
    if (!apiOrigin) {
      // Web/dev mode: API is same-origin with the page.
      return typeof window !== "undefined"
        ? new URL(url).origin === window.location.origin
        : false;
    }
    return new URL(url).origin === new URL(apiOrigin).origin;
  } catch {
    return false;
  }
}

// Case-media file endpoints (/api/cases/:id/attachments/:attId/file, etc.)
// require a bearer Authorization header. A plain <img>/<video src> cannot send
// that header, so the browser request 401s and the media renders blank. These
// components fetch the URL with the token, turn the response into an object URL,
// and render the result. data:/blob: URIs are used directly (no auth needed).
function useAuthedObjectUrl(url: string | null | undefined): {
  src: string | null;
  loading: boolean;
  error: boolean;
} {
  const [state, setState] = useState<{
    src: string | null;
    loading: boolean;
    error: boolean;
  }>({ src: null, loading: !!url, error: false });

  useEffect(() => {
    if (!url) {
      setState({ src: null, loading: false, error: false });
      return;
    }
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      setState({ src: url, loading: false, error: false });
      return;
    }
    // Only our own API origin gets the bearer token + blob round-trip. Anything
    // else (third-party hosts) is rendered directly without auth so the token
    // never leaks.
    if (!isSameApiOrigin(url)) {
      setState({ src: url, loading: false, error: false });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ src: null, loading: true, error: false });
    (async () => {
      try {
        // Wait for the token store to finish loading from localStorage/keychain
        // before the first fetch, so we never send an unauthenticated request
        // due to a startup race between hydration and the first render.
        await waitForTokenHydration();
        if (cancelled) return;
        const resp = await authedMediaFetch(url, controller.signal);
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const blob = await resp.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ src: objectUrl, loading: false, error: false });
      } catch {
        if (!cancelled) setState({ src: null, loading: false, error: true });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return state;
}

export function AuthedImage({
  url,
  alt,
  className,
  title,
  onClick,
  fallback,
}: {
  url: string;
  alt?: string;
  className?: string;
  title?: string;
  onClick?: MouseEventHandler<HTMLImageElement>;
  // Rendered when the file can't be loaded (e.g. bytes permanently lost). When
  // omitted, the component renders nothing on error (legacy behavior).
  fallback?: ReactNode;
}) {
  const { src, loading, error } = useAuthedObjectUrl(url);
  if (error) return fallback ? <>{fallback}</> : null;
  if (loading || !src)
    return <div className={className} aria-busy={loading ? true : undefined} />;
  return (
    <img src={src} alt={alt} className={className} title={title} onClick={onClick} />
  );
}

export function AuthedVideo({
  url,
  className,
  mimeType,
  controls,
  autoPlay,
  muted,
  playsInline,
  preload,
  onClick,
}: {
  url: string;
  className?: string;
  mimeType?: string;
  controls?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  playsInline?: boolean;
  preload?: "auto" | "metadata" | "none";
  onClick?: MouseEventHandler<HTMLVideoElement>;
}) {
  const { src, loading, error } = useAuthedObjectUrl(url);
  if (error) return null;
  if (loading || !src)
    return <div className={className} aria-busy={loading ? true : undefined} />;
  return (
    <video
      src={src}
      className={className}
      controls={controls}
      autoPlay={autoPlay}
      muted={muted}
      playsInline={playsInline}
      preload={preload}
      onClick={onClick}
    >
      {mimeType && <source src={src} type={mimeType} />}
    </video>
  );
}

export type Lightbox =
  | { url: string; kind: "image" | "video"; mimeType?: string }
  | null;

// Full-screen media lightbox shared by the case-detail drawer (cases.tsx) and
// the prescription/history preview (PrescriptionPreview.tsx). It renders the
// full-size image through AuthedImage (and video through AuthedVideo) so the
// protected /file bytes are fetched WITH a bearer token and shown from the
// resulting object URL — a plain <img src="…/file"> here would 401 and go
// blank for authenticated desktop users. Kept as a single component so the
// image path can never silently regress to an unauthenticated <img> in one
// caller. `overlayClassName` lets each caller keep its own stacking context
// (z-index) without changing behaviour.
export function MediaLightbox({
  lightbox,
  onClose,
  overlayClassName = "fixed inset-0 z-[70] bg-black/90 flex items-center justify-center",
}: {
  lightbox: Lightbox;
  onClose: () => void;
  overlayClassName?: string;
}) {
  if (!lightbox) return null;
  return (
    <div className={overlayClassName} onClick={onClose}>
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 h-10 w-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
      >
        <X size={20} />
      </button>
      {lightbox.kind === "video" ? (
        <AuthedVideo
          url={lightbox.url}
          controls
          autoPlay
          mimeType={lightbox.mimeType}
          className="max-w-[90vw] max-h-[90vh] rounded-lg bg-black"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <AuthedImage
          url={lightbox.url}
          alt="Preview"
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
