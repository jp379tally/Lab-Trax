import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { WebView } from "react-native-webview";
import * as FileSystem from "expo-file-system/legacy";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { acquireAuthedMediaUri } from "@/lib/authed-media-cache";
import { shareLocalFile } from "@/lib/open-attachment";
import { buildViewerHtml, type ScanFormat } from "@workspace/scan-viewer";

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function textureMimeFromBase64(base64: string): string | null {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("UklGR") && atob(base64.slice(0, 24)).includes("WEBP")) return "image/webp";
  return null;
}

type ViewerStatus = "loading" | "ready" | "error";

export default function ScanViewerScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    url?: string | string[];
    fileName?: string | string[];
    fileType?: string | string[];
    format?: string | string[];
    textureUrl?: string | string[];
  }>();

  const url = firstParam(params.url);
  const fileName = firstParam(params.fileName);
  const fileType = firstParam(params.fileType);
  const format = (firstParam(params.format) ?? "ply") as ScanFormat;
  const textureUrl = firstParam(params.textureUrl);

  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [viewerHtml, setViewerHtml] = useState<string | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let release = () => {};

    if (!url) {
      setStatus("error");
      return;
    }

    setStatus("loading");
    setViewerHtml(null);
    setLocalUri(null);

    (async () => {
      const acquired = await acquireAuthedMediaUri(url);
      if (cancelled) {
        acquired?.release();
        return;
      }
      if (!acquired) {
        setStatus("error");
        return;
      }
      release = acquired.release;
      const uri = acquired.uri;
      setLocalUri(uri);

      try {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (cancelled) return;
        let texture: { base64: string; mimeType: string } | undefined;
        if (textureUrl) {
          try {
            const textureAcquired = await acquireAuthedMediaUri(textureUrl);
            if (textureAcquired) {
              try {
                const textureBase64 = await FileSystem.readAsStringAsync(textureAcquired.uri, {
                  encoding: FileSystem.EncodingType.Base64,
                });
                const mimeType = textureMimeFromBase64(textureBase64);
                if (mimeType) texture = { base64: textureBase64, mimeType };
              } finally {
                textureAcquired.release();
              }
            }
          } catch {
            // A missing/revoked companion image must not hide the scan itself.
          }
        }
        const html = buildViewerHtml(base64, format, texture);
        setViewerHtml(html);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      release();
    };
  }, [url, textureUrl, fileName, fileType, format]);

  async function handleShare(): Promise<void> {
    if (!localUri) return;
    await shareLocalFile(localUri, { fileName, fileType });
  }

  const styles = makeStyles(colors);
  const ready = status === "ready" && !!viewerHtml;

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          testID="scan-back"
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>

        <Text style={styles.headerTitle} numberOfLines={1}>
          {fileName || "3D Model"}
        </Text>

        <Pressable
          onPress={handleShare}
          hitSlop={12}
          style={styles.headerButton}
          disabled={!localUri}
          accessibilityRole="button"
          accessibilityLabel="Share file"
          testID="scan-share"
        >
          <Ionicons
            name="share-outline"
            size={22}
            color={localUri ? colors.tint : colors.textTertiary}
          />
        </Pressable>
      </View>

      <View style={styles.body}>
        {status === "loading" ? (
          <View style={styles.center} testID="scan-loading">
            <ActivityIndicator color={colors.tint} />
            <Text style={styles.loadingText}>Loading 3D model…</Text>
          </View>
        ) : status === "error" || !viewerHtml ? (
          <View style={styles.center} testID="scan-error">
            <Ionicons name="cube-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.errorTitle}>Couldn&apos;t open 3D model</Text>
            <Text style={styles.errorBody}>
              The file could not be downloaded. Please check your connection and try again.
            </Text>
            <Pressable onPress={() => router.back()} style={styles.errorButton}>
              <Text style={styles.errorButtonText}>Go back</Text>
            </Pressable>
          </View>
        ) : (
          <WebView
            testID="scan-webview"
            source={{ html: viewerHtml }}
            originWhitelist={["*"]}
            javaScriptEnabled
            domStorageEnabled
            allowFileAccess
            style={styles.webview}
            onError={() => setStatus("error")}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: "#18181b",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    },
    headerButton: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      textAlign: "center",
      fontSize: 16,
      fontWeight: "600",
      color: colors.text,
      marginHorizontal: 8,
    },
    body: {
      flex: 1,
    },
    webview: {
      flex: 1,
      backgroundColor: "#18181b",
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      gap: 12,
    },
    loadingText: {
      fontSize: 14,
      color: colors.textTertiary,
    },
    errorTitle: {
      fontSize: 16,
      fontWeight: "600",
      color: colors.text,
      textAlign: "center",
    },
    errorBody: {
      fontSize: 14,
      color: colors.textTertiary,
      textAlign: "center",
    },
    errorButton: {
      marginTop: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: colors.tint,
    },
    errorButtonText: {
      color: "#FFFFFF", // hex-allow: white text on tint-colored button
      fontWeight: "600",
      fontSize: 15,
    },
  });
}
