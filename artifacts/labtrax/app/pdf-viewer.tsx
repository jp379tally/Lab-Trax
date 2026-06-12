import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import {
  downloadAttachmentToLocalFile,
  shareLocalFile,
} from "@/lib/open-attachment";

// useLocalSearchParams values are `string | string[]` — coerce to a single value.
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

type ViewerStatus = "loading" | "ready" | "error";

// Full-screen, in-app document viewer for PDF attachments. The remote media
// endpoint is Bearer-protected, so we download the file to a local file:// URI
// (with the real extension) and render it inline. On iOS, WKWebView renders the
// PDF natively with pinch-zoom, scrolling, and page navigation. The OS share
// sheet is reached only through the explicit Share button in the header.
export default function PdfViewerScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    url?: string | string[];
    fileName?: string | string[];
    fileType?: string | string[];
  }>();

  const url = firstParam(params.url);
  const fileName = firstParam(params.fileName);
  const fileType = firstParam(params.fileType);

  const [localUri, setLocalUri] = useState<string | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    if (!url) {
      setStatus("error");
      return;
    }

    setStatus("loading");
    setLocalUri(null);

    (async () => {
      const uri = await downloadAttachmentToLocalFile({ url, fileName, fileType });
      if (cancelled) return;
      if (uri) {
        setLocalUri(uri);
        setStatus("ready");
      } else {
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, fileName, fileType]);

  // WKWebView needs read access to the directory containing the local file.
  const readAccessDir = useMemo(() => {
    if (!localUri) return undefined;
    const slash = localUri.lastIndexOf("/");
    return slash >= 0 ? localUri.slice(0, slash + 1) : undefined;
  }, [localUri]);

  async function handleShare(): Promise<void> {
    if (!localUri) return;
    await shareLocalFile(localUri, { fileName, fileType });
  }

  const styles = makeStyles(colors);
  const ready = status === "ready" && !!localUri;

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          testID="pdf-back"
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>

        <Text style={styles.headerTitle} numberOfLines={1}>
          {fileName || "Document"}
        </Text>

        <Pressable
          onPress={handleShare}
          hitSlop={12}
          style={styles.headerButton}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityLabel="Share document"
          testID="pdf-share"
        >
          <Ionicons
            name="share-outline"
            size={22}
            color={ready ? colors.tint : colors.textTertiary}
          />
        </Pressable>
      </View>

      <View style={styles.body}>
        {status === "loading" ? (
          <View style={styles.center} testID="pdf-loading">
            <ActivityIndicator color={colors.tint} />
          </View>
        ) : status === "error" || !localUri ? (
          <View style={styles.center} testID="pdf-error">
            <Ionicons name="document-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.errorTitle}>This document couldn&apos;t be opened.</Text>
            <Text style={styles.errorBody}>
              The file could not be downloaded. Please check your connection and try again.
            </Text>
            <Pressable onPress={() => router.back()} style={styles.errorButton}>
              <Text style={styles.errorButtonText}>Go back</Text>
            </Pressable>
          </View>
        ) : (
          <WebView
            testID="pdf-webview"
            source={{ uri: localUri }}
            originWhitelist={["*"]}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            allowingReadAccessToURL={
              Platform.OS === "ios" ? readAccessDir : undefined
            }
            startInLoadingState
            renderLoading={() => (
              <View style={styles.center}>
                <ActivityIndicator color={colors.tint} />
              </View>
            )}
            onError={() => setStatus("error")}
            style={styles.webview}
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
      backgroundColor: colors.backgroundSolid,
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
      backgroundColor: colors.backgroundSolid,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      gap: 12,
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
