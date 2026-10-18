import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Film,
  Loader2,
  LocateFixed,
  Minus,
  Play,
  Plus,
  X,
} from "lucide-react";
import { authedMediaFetch, getApiOrigin, waitForTokenHydration } from "@/lib/api";
import { classifyMediaKind } from "@/lib/media-kind";
import type { CaseAttachment } from "@/lib/types";
export { classifyMediaKind } from "@/lib/media-kind";

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
  onKeyDown,
  tabIndex,
  style,
  fallback,
}: {
  url: string;
  alt?: string;
  className?: string;
  title?: string;
  onClick?: MouseEventHandler<HTMLImageElement>;
  onKeyDown?: KeyboardEventHandler<HTMLImageElement>;
  tabIndex?: number;
  style?: CSSProperties;
  // Rendered when the file can't be loaded (e.g. bytes permanently lost). When
  // omitted, the component renders nothing on error (legacy behavior).
  fallback?: ReactNode;
}) {
  const { src, loading, error } = useAuthedObjectUrl(url);
  if (error) return fallback ? <>{fallback}</> : null;
  if (loading || !src)
    return <div className={className} aria-busy={loading ? true : undefined} />;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      title={title}
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      style={style}
    />
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
  loadingFallback,
  errorFallback,
  onPlaybackError,
  onLoadError,
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
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode;
  onPlaybackError?: () => void;
  onLoadError?: () => void;
}) {
  const { src, loading, error } = useAuthedObjectUrl(url);
  useEffect(() => {
    if (error) onLoadError?.();
  }, [error, onLoadError]);
  if (error) return errorFallback ? <>{errorFallback}</> : null;
  if (loading || !src) {
    return loadingFallback ? (
      <>{loadingFallback}</>
    ) : (
      <div className={className} aria-busy={loading ? true : undefined} />
    );
  }
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
      onError={onPlaybackError}
    >
      {mimeType && <source src={src} type={mimeType} />}
    </video>
  );
}

export type LightboxItem = {
  url: string;
  kind: "image" | "video";
  mimeType?: string;
  fileName?: string;
  /** Stable server identity used to keep a refresh from changing the open file. */
  attachmentId?: string;
};

export type Lightbox =
  | (LightboxItem & {
      /** Ordered current-case media, not documents or 3D scans. */
      gallery?: LightboxItem[];
    })
  | null;

const PLAYABLE_VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv", "ogg"]);

export function isLikelyBrowserPlayableVideo(
  mimeType?: string,
  fileName?: string,
): boolean {
  const normalizedMime = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = (fileName?.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (normalizedMime === "video/quicktime" || extension === "mov") return false;
  if (PLAYABLE_VIDEO_EXTENSIONS.has(extension)) return true;
  return new Set(["video/mp4", "video/webm", "video/ogg"]).has(normalizedMime);
}

/**
 * Build the stable, image/video-only sequence used by the desktop case viewer.
 * The API's attachment order is intentionally preserved; identity is retained
 * separately from the URL so a refreshed list cannot silently select another
 * file at the same position.
 */
export function buildCaseMediaGallery(
  caseId: string,
  attachments: CaseAttachment[] | undefined,
): LightboxItem[] {
  return (attachments ?? []).flatMap((attachment) => {
    const kind = classifyMediaKind(attachment.fileType, attachment.fileName);
    if (!kind) return [];
    return [
      {
        attachmentId: attachment.id,
        url: `${getApiOrigin()}/api/cases/${caseId}/attachments/${attachment.id}/file`,
        kind,
        mimeType: attachment.fileType || undefined,
        fileName: attachment.fileName,
      } satisfies LightboxItem,
    ];
  });
}

export async function downloadAuthenticatedMedia(
  url: string,
  fileName: string,
): Promise<void> {
  await waitForTokenHydration();
  const separator = url.includes("?") ? "&" : "?";
  const response = await authedMediaFetch(`${url}${separator}download=1`);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

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
  activeItemIdentity,
  onActiveItemChange,
  overlayClassName = "fixed inset-0 z-[70] bg-black/90 flex items-center justify-center",
}: {
  lightbox: Lightbox;
  onClose: () => void;
  /** Optional controlled identity for callers whose gallery can refresh. */
  activeItemIdentity?: string | null;
  onActiveItemChange?: (identity: string) => void;
  overlayClassName?: string;
}) {
  const gallery = lightbox?.gallery ?? [];
  const initialIdentity = lightbox?.attachmentId ?? lightbox?.url ?? null;
  const [internalSelectedIdentity, setInternalSelectedIdentity] =
    useState(initialIdentity);
  const selectedIdentity =
    activeItemIdentity === undefined
      ? internalSelectedIdentity
      : activeItemIdentity;
  const hasGalleryProp = lightbox?.gallery !== undefined;
  const [imageScale, setImageScale] = useState(1);
  const [transformOrigin, setTransformOrigin] = useState("50% 50%");
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [videoPlaybackFailed, setVideoPlaybackFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    imageBounds: DOMRect;
    viewportBounds: DOMRect;
  } | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const minimumVisiblePixels = 40;
  const minimumImageScale = 1;
  const maximumImageScale = 5;
  const keyboardZoomStep = 0.25;
  const activeIndex =
    gallery.length > 0
      ? gallery.findIndex(
          (item) =>
            (item.attachmentId ?? item.url) ===
            (selectedIdentity ?? initialIdentity),
        )
      : -1;
  const activeItem =
    activeIndex >= 0
      ? gallery[activeIndex]!
      : !hasGalleryProp && lightbox
        ? lightbox
        : null;
  const hasGallery = hasGalleryProp && gallery.length > 0 && activeIndex >= 0;
  const activeMediaIdentity =
    activeItem?.attachmentId ?? activeItem?.url ?? null;
  const activeMediaKind = activeItem?.kind ?? null;

  useEffect(() => {
    setInternalSelectedIdentity(initialIdentity);
  }, [initialIdentity]);

  useEffect(() => {
    if (!lightbox || !hasGalleryProp || activeIndex >= 0) return;
    onClose();
  }, [activeIndex, hasGalleryProp, lightbox, onClose]);

  useEffect(() => {
    setImageScale(1);
    setTransformOrigin("50% 50%");
    setImagePan({ x: 0, y: 0 });
    setVideoPlaybackFailed(false);
    setDownloadFailed(false);
    dragRef.current = null;
  }, [lightbox?.kind, lightbox?.url, lightbox?.attachmentId]);

  const adjustImageScale = (delta: number) => {
    setImageScale((currentScale) =>
      Math.max(
        minimumImageScale,
        Math.min(maximumImageScale, currentScale + delta),
      ),
    );
    // Recenter before applying a new scale. Keeping a translation calculated
    // for a larger image can move a smaller image entirely off-screen.
    setImagePan({ x: 0, y: 0 });
  };

  useEffect(() => {
    const container = imageContainerRef.current;
    // Use the currently displayed gallery item, rather than the original
    // lightbox prop. Internal gallery navigation leaves the prop unchanged,
    // so checking `lightbox.kind` would fail to reinstall this handler after
    // a video → image transition.
    if (!container || activeMediaKind !== "image") return;

    const handleImageWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !(event.target instanceof HTMLImageElement)) return;

      event.preventDefault();
      const bounds = event.target.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        const originX = ((event.clientX - bounds.left) / bounds.width) * 100;
        const originY = ((event.clientY - bounds.top) / bounds.height) * 100;
        setTransformOrigin(
          `${Math.max(0, Math.min(100, originX))}% ${Math.max(0, Math.min(100, originY))}%`,
        );
      }
      setImageScale((currentScale) => {
        const nextScale = Math.max(
          minimumImageScale,
          Math.min(
            maximumImageScale,
            currentScale * (event.deltaY < 0 ? 1.25 : 0.8),
          ),
        );
        // Recenter before applying a new scale. Keeping a translation calculated
        // for a larger image can move a smaller image entirely off-screen.
        setImagePan({ x: 0, y: 0 });
        return nextScale;
      });
    };

    container.addEventListener("wheel", handleImageWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleImageWheel);
  }, [activeMediaIdentity, activeMediaKind]);

  const handlePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (
      imageScale <= 1 ||
      event.button !== 0 ||
      !(event.target instanceof HTMLImageElement)
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: imagePan.x,
      panY: imagePan.y,
      imageBounds: event.target.getBoundingClientRect(),
      viewportBounds: event.currentTarget.parentElement!.getBoundingClientRect(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const minDeltaX =
      drag.viewportBounds.left + minimumVisiblePixels - drag.imageBounds.right;
    const maxDeltaX =
      drag.viewportBounds.right - minimumVisiblePixels - drag.imageBounds.left;
    const minDeltaY =
      drag.viewportBounds.top + minimumVisiblePixels - drag.imageBounds.bottom;
    const maxDeltaY =
      drag.viewportBounds.bottom - minimumVisiblePixels - drag.imageBounds.top;

    setImagePan({
      x: drag.panX + Math.max(minDeltaX, Math.min(maxDeltaX, deltaX)),
      y: drag.panY + Math.max(minDeltaY, Math.min(maxDeltaY, deltaY)),
    });
  };

  const navigate = (direction: -1 | 1) => {
    if (!hasGallery) return;
    const nextIndex = activeIndex + direction;
    if (nextIndex < 0 || nextIndex >= gallery.length) return;
    const next = gallery[nextIndex]!;
    const nextIdentity = next.attachmentId ?? next.url;
    setInternalSelectedIdentity(nextIdentity);
    onActiveItemChange?.(nextIdentity);
    setImageScale(1);
    setTransformOrigin("50% 50%");
    setImagePan({ x: 0, y: 0 });
    setVideoPlaybackFailed(false);
    setDownloadFailed(false);
    dragRef.current = null;
  };

  useEffect(() => {
    if (!lightbox || !hasGallery) return;
    const handleGalleryKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (imageScale > 1) return;
      event.preventDefault();
      navigate(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", handleGalleryKeyDown);
    return () => window.removeEventListener("keydown", handleGalleryKeyDown);
  }, [lightbox, hasGallery, imageScale, activeIndex, gallery]);

  const handleImageKeyDown: KeyboardEventHandler<HTMLImageElement> = (event) => {
    if (imageScale <= 1) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        navigate(event.key === "ArrowLeft" ? -1 : 1);
      }
      return;
    }

    const keyboardPanStep = 40;
    const deltas: Partial<Record<string, { x: number; y: number }>> = {
      ArrowLeft: { x: -keyboardPanStep, y: 0 },
      ArrowRight: { x: keyboardPanStep, y: 0 },
      ArrowUp: { x: 0, y: -keyboardPanStep },
      ArrowDown: { x: 0, y: keyboardPanStep },
    };
    const delta = deltas[event.key];
    if (!delta) return;

    const viewport = event.currentTarget.parentElement?.parentElement;
    if (!viewport) return;

    event.preventDefault();
    event.stopPropagation();
    const imageBounds = event.currentTarget.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    const minDeltaX =
      viewportBounds.left + minimumVisiblePixels - imageBounds.right;
    const maxDeltaX =
      viewportBounds.right - minimumVisiblePixels - imageBounds.left;
    const minDeltaY =
      viewportBounds.top + minimumVisiblePixels - imageBounds.bottom;
    const maxDeltaY =
      viewportBounds.bottom - minimumVisiblePixels - imageBounds.top;

    setImagePan((currentPan) => ({
      x: currentPan.x + Math.max(minDeltaX, Math.min(maxDeltaX, delta.x)),
      y: currentPan.y + Math.max(minDeltaY, Math.min(maxDeltaY, delta.y)),
    }));
  };

  const handlePointerEnd: PointerEventHandler<HTMLDivElement> = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  if (!lightbox || !activeItem) return null;
  const displayedLightbox = activeItem;
  const videoSupported =
    displayedLightbox.kind !== "video" ||
    isLikelyBrowserPlayableVideo(
      displayedLightbox.mimeType,
      displayedLightbox.fileName,
    );
  const showVideoFallback =
    displayedLightbox.kind === "video" && (!videoSupported || videoPlaybackFailed);

  const downloadVideo = async () => {
    if (displayedLightbox.kind !== "video" || downloading) return;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      await downloadAuthenticatedMedia(
        displayedLightbox.url,
        displayedLightbox.fileName || "video",
      );
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className={overlayClassName}
      onClick={onClose}
      data-testid="media-lightbox-backdrop"
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label="Close preview"
        className="absolute z-10 top-4 right-4 h-10 w-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors"
      >
        <X size={20} />
      </button>
      {hasGallery && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              navigate(-1);
            }}
            disabled={activeIndex <= 0}
            aria-label="Previous media"
            className="absolute left-4 top-1/2 z-10 -translate-y-1/2 h-11 w-11 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 transition-colors"
          >
            <ArrowLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              navigate(1);
            }}
            disabled={activeIndex >= gallery.length - 1}
            aria-label="Next media"
            className="absolute right-4 top-1/2 z-10 -translate-y-1/2 h-11 w-11 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 transition-colors"
          >
            <ArrowRight size={22} />
          </button>
          <div
            className="absolute z-10 top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium tabular-nums text-white"
            data-testid="media-lightbox-position"
            aria-live="polite"
          >
            {activeIndex + 1} / {gallery.length}
          </div>
        </>
      )}
      {displayedLightbox.kind === "image" && imageScale > 1 && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            dragRef.current = null;
            setImagePan({ x: 0, y: 0 });
            setTransformOrigin("50% 50%");
          }}
          aria-label="Recenter image"
          className="absolute z-10 top-4 left-4 h-10 px-3 rounded-full bg-white/10 text-white flex items-center gap-2 hover:bg-white/20 transition-colors"
        >
          <LocateFixed size={18} />
          <span className="text-sm font-medium">Recenter</span>
        </button>
      )}
      {displayedLightbox.kind === "image" && (
        <div
          className="absolute z-10 bottom-4 left-1/2 -translate-x-1/2 flex items-center rounded-full bg-black/60 text-white shadow-lg"
          onClick={(event) => event.stopPropagation()}
          aria-label="Image zoom controls"
        >
          <button
            type="button"
            onClick={() => adjustImageScale(-keyboardZoomStep)}
            disabled={imageScale <= minimumImageScale}
            aria-label="Zoom out"
            className="h-10 w-10 rounded-l-full flex items-center justify-center hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          >
            <Minus size={18} />
          </button>
          <output
            aria-live="polite"
            className="min-w-14 text-center text-sm font-medium tabular-nums"
          >
            {Math.round(imageScale * 100)}%
          </output>
          <button
            type="button"
            onClick={() => adjustImageScale(keyboardZoomStep)}
            disabled={imageScale >= maximumImageScale}
            aria-label="Zoom in"
            className="h-10 w-10 rounded-r-full flex items-center justify-center hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          >
            <Plus size={18} />
          </button>
        </div>
      )}
      {displayedLightbox.kind === "video" ? (
        showVideoFallback ? (
          <div
            className="mx-6 w-full max-w-lg rounded-xl bg-background p-8 text-center shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <Film className="mx-auto mb-4 text-muted-foreground" size={40} />
            <h2 className="text-lg font-semibold">This video can’t be played here</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {videoPlaybackFailed
                ? "The clip could not be loaded or its codec is not supported by this browser."
                : "This format is not supported by most browsers. Download it to open it with a compatible video player."}
            </p>
            <button
              type="button"
              onClick={() => void downloadVideo()}
              disabled={downloading}
              className="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {downloading ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />}
              Download {displayedLightbox.fileName || "video"}
            </button>
            {downloadFailed && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                The download could not be started. Please try again.
              </p>
            )}
          </div>
        ) : (
          <AuthedVideo
            url={displayedLightbox.url}
            controls
            autoPlay
            playsInline
            mimeType={displayedLightbox.mimeType}
            className="max-w-[90vw] max-h-[90vh] rounded-lg bg-black"
            onClick={(e) => e.stopPropagation()}
            onPlaybackError={() => setVideoPlaybackFailed(true)}
            onLoadError={() => setVideoPlaybackFailed(true)}
            loadingFallback={
              <div className="flex items-center gap-2 rounded-lg bg-black/70 px-4 py-3 text-white">
                <Loader2 className="animate-spin" size={18} />
                Loading video…
              </div>
            }
          />
        )
      ) : (
        <div
          ref={imageContainerRef}
          className="contents"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          <AuthedImage
             url={displayedLightbox.url}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleImageKeyDown}
            tabIndex={imageScale > 1 ? 0 : undefined}
            style={{
              transform: `translate3d(${imagePan.x}px, ${imagePan.y}px, 0) scale(${imageScale})`,
              transformOrigin,
              cursor: imageScale > 1 ? "grab" : "default",
              touchAction: imageScale > 1 ? "none" : "auto",
            }}
          />
        </div>
      )}
    </div>
  );
}
