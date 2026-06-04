import { useEffect, useState, type MouseEventHandler, type ReactNode } from "react";
import { getAccessToken, getApiOrigin } from "@/lib/api";

// True only when `url` is an absolute URL whose origin matches our API origin.
// The bearer token must NEVER be sent to a third-party host, so we validate the
// origin before attaching the Authorization header.
export function isSameApiOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(getApiOrigin()).origin;
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
    setState({ src: null, loading: true, error: false });
    (async () => {
      try {
        const token = getAccessToken();
        const resp = await fetch(
          url,
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        );
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
