import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Image } from "expo-image";
import { caseMediaSource, isCaseMediaUrl } from "@/lib/case-media-source";
import { refreshAuthForMedia } from "@/lib/query-client";

type ExpoImageProps = ComponentProps<typeof Image>;

export type AuthedImageProps = Omit<ExpoImageProps, "source"> & {
  uri: string | null | undefined;
};

// Self-healing image for auth-gated case media (photos/thumbnails).
//
// Native <Image> attaches the bearer token synchronously via caseMediaSource()
// (expo-image source.headers). If that in-memory token is missing (cold start
// before loadTokens ran) or expired at render time, the file request 401s and
// the image renders BLANK with no retry — unlike resilientFetch JSON calls,
// which refresh + retry. That is why case history (JSON) recovers but photos do
// not. This wrapper catches the load error, refreshes the token once, and
// re-renders with fresh headers by bumping recyclingKey so the photo loads.
export function AuthedImage({
  uri,
  onError,
  recyclingKey,
  ...rest
}: AuthedImageProps) {
  const [attempt, setAttempt] = useState(0);
  const refreshing = useRef(false);

  // Reset the one-shot retry whenever the URI changes. Lists key images by
  // index (key={idx}), so a single component instance is reused for different
  // photos; without this, a later photo would start at attempt=1 and never get
  // its self-heal retry.
  useEffect(() => {
    setAttempt(0);
    refreshing.current = false;
  }, [uri]);

  // Recompute the source whenever `attempt` changes so caseMediaSource() reads
  // the freshly-rotated token from memory and attaches new headers.
  const source = useMemo(() => caseMediaSource(uri), [uri, attempt]);

  const handleError = useCallback<NonNullable<ExpoImageProps["onError"]>>(
    (event) => {
      // Only one refresh+retry, and only for our own auth-gated media — a token
      // refresh can't fix a third-party or genuinely-broken URL.
      if (attempt === 0 && uri && isCaseMediaUrl(uri) && !refreshing.current) {
        refreshing.current = true;
        void refreshAuthForMedia()
          .then(() => setAttempt(1))
          .catch(() => {})
          .finally(() => {
            refreshing.current = false;
          });
        return;
      }
      onError?.(event);
    },
    [attempt, uri, onError],
  );

  return (
    <Image
      {...rest}
      source={source}
      recyclingKey={recyclingKey ?? (uri ? `${uri}:${attempt}` : undefined)}
      onError={handleError}
    />
  );
}
