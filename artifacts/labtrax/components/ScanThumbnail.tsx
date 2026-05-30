import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Image } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system";
import {
  arrayBufferToBase64,
  buildThumbnailHtml,
  type ScanFormat,
} from "@workspace/scan-viewer";
import { useTheme } from "@/lib/theme-context";

interface ScanThumbnailProps {
  cacheKey: string;
  fileUrl: string;
  format: ScanFormat;
  fileName: string;
  authToken?: string | null;
  /** Display size in dp. Default 40. */
  size?: number;
}

type Status = "loading" | "rendering" | "ready" | "error";

// Module-level cache so re-opening the case doesn't re-fetch / re-render.
const thumbCache = new Map<string, string>();
const failed = new Set<string>();

// Concurrency cap — opening a case with many .stl attachments shouldn't fan
// out and saturate the device's network / GPU.
const MAX_CONCURRENT = 1;
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

async function downloadAndEncode(
  fileUrl: string,
  fileName: string,
  authToken: string | null | undefined,
): Promise<string> {
  const safeName =
    "thumb_" + fileName.replace(/[^a-zA-Z0-9._-]/g, "_") + "_" + Date.now();
  const dest = new FileSystem.File(FileSystem.Paths.cache, safeName);
  try {
    if (dest.exists) dest.delete();
  } catch {
    // best-effort
  }
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const downloaded = await FileSystem.File.downloadFileAsync(fileUrl, dest, { headers });
  try {
    const bytes = await downloaded.bytes();
    return arrayBufferToBase64(bytes);
  } finally {
    try {
      downloaded.delete();
    } catch {
      // best-effort
    }
  }
}

export default function ScanThumbnail({
  cacheKey,
  fileUrl,
  format,
  fileName,
  authToken,
  size = 40,
}: ScanThumbnailProps) {
  const { colors } = useTheme();
  const initialStatus = useMemo<Status>(() => {
    if (thumbCache.has(cacheKey)) return "ready";
    if (failed.has(cacheKey)) return "error";
    return "loading";
  }, [cacheKey]);
  const [status, setStatus] = useState<Status>(initialStatus);
  const [dataUrl, setDataUrl] = useState<string | null>(
    () => thumbCache.get(cacheKey) ?? null,
  );
  const [html, setHtml] = useState<string | null>(null);
  const cancelled = useRef(false);
  const releasedRef = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    releasedRef.current = false;

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
    (async () => {
      try {
        await acquireSlot();
        if (cancelled.current) {
          releasedRef.current = true;
          releaseSlot();
          return;
        }
        const base64 = await downloadAndEncode(fileUrl, fileName, authToken);
        if (cancelled.current) {
          releasedRef.current = true;
          releaseSlot();
          return;
        }
        const renderSize = Math.max(96, Math.round(size * 3));
        setHtml(buildThumbnailHtml(base64, format, { size: renderSize }));
        setStatus("rendering");
      } catch {
        failed.add(cacheKey);
        if (!cancelled.current) setStatus("error");
        if (!releasedRef.current) {
          releasedRef.current = true;
          releaseSlot();
        }
      }
    })();

    return () => {
      cancelled.current = true;
      if (!releasedRef.current) {
        releasedRef.current = true;
        releaseSlot();
      }
    };
  }, [cacheKey, fileUrl, fileName, format, authToken, size]);

  function onWebViewMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {
        type?: string;
        dataUrl?: string;
      };
      if (msg.type === "thumb" && typeof msg.dataUrl === "string") {
        thumbCache.set(cacheKey, msg.dataUrl);
        if (!cancelled.current) {
          setDataUrl(msg.dataUrl);
          setStatus("ready");
        }
      } else if (msg.type === "error") {
        failed.add(cacheKey);
        if (!cancelled.current) setStatus("error");
      }
    } catch {
      // ignore
    }
    setHtml(null);
    if (!releasedRef.current) {
      releasedRef.current = true;
      releaseSlot();
    }
  }

  function onWebViewError() {
    failed.add(cacheKey);
    if (!cancelled.current) setStatus("error");
    setHtml(null);
    if (!releasedRef.current) {
      releasedRef.current = true;
      releaseSlot();
    }
  }

  const containerStyle = {
    width: size,
    height: size,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    overflow: "hidden" as const,
  };

  return (
    <View style={containerStyle}>
      {status === "ready" && dataUrl ? (
        <Image
          source={{ uri: dataUrl }}
          style={{ width: size, height: size }}
          resizeMode="cover"
        />
      ) : (
        <Ionicons
          name="cube-outline"
          size={Math.round(size * 0.5)}
          color={colors.textSecondary}
        />
      )}
      {status === "rendering" && html != null && (
        // Hidden off-screen WebView that renders one frame and posts back a
        // PNG data URL. We deliberately mount it absolutely off-screen rather
        // than display:none / 0×0 so the WebGL context actually initialises.
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: -10000,
            top: 0,
            width: 192,
            height: 192,
            opacity: 0,
          }}
        >
          <WebView
            style={{ width: 192, height: 192, backgroundColor: "transparent" }}
            source={{ html }}
            originWhitelist={["*"]}
            javaScriptEnabled
            scrollEnabled={false}
            onMessage={onWebViewMessage}
            onError={onWebViewError}
            onHttpError={onWebViewError}
            androidLayerType="hardware"
          />
        </View>
      )}
    </View>
  );
}
