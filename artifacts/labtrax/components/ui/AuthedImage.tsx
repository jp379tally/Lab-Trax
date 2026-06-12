import React, { useEffect, useState } from "react";
import { Image } from "expo-image";
import type { StyleProp } from "react-native";
import type { ImageStyle } from "expo-image";
import { getAuthedMediaUri } from "@/lib/authed-media-cache";

interface AuthedImageProps {
  url: string | null | undefined;
  style?: StyleProp<ImageStyle>;
  contentFit?: "cover" | "contain" | "fill" | "none" | "scale-down";
  resizeMode?: "cover" | "contain" | "fill" | "none" | "scale-down";
  testID?: string;
}

export function AuthedImage({ url, style, contentFit, resizeMode, testID }: AuthedImageProps) {
  const [localUri, setLocalUri] = useState<string | null>(null);

  useEffect(() => {
    if (!url) { setLocalUri(null); return; }
    let cancelled = false;
    getAuthedMediaUri(url)
      .then((uri) => { if (!cancelled) setLocalUri(uri); })
      .catch(() => { if (!cancelled) setLocalUri(null); });
    return () => { cancelled = true; };
  }, [url]);

  return (
    <Image
      source={localUri ? { uri: localUri } : undefined}
      style={style}
      contentFit={contentFit ?? resizeMode ?? "cover"}
      testID={testID}
    />
  );
}
