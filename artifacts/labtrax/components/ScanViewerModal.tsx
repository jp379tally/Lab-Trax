import React, { useState, useEffect, useRef } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  StatusBar,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as FileSystem from "expo-file-system";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  buildViewerHtml,
  arrayBufferToBase64,
  type ScanFormat as SharedScanFormat,
} from "@workspace/scan-viewer";

export type ScanFormat = SharedScanFormat;

interface ScanViewerModalProps {
  visible: boolean;
  fileUrl: string;
  fileName: string;
  format: ScanFormat;
  authToken?: string | null;
  onClose: () => void;
  onFallback: () => void;
}

type LoadState = "downloading" | "rendering" | "error";

export default function ScanViewerModal({
  visible,
  fileUrl,
  fileName,
  format,
  authToken,
  onClose,
  onFallback,
}: ScanViewerModalProps) {
  const insets = useSafeAreaInsets();
  const [loadState, setLoadState] = useState<LoadState>("downloading");
  const [htmlSource, setHtmlSource] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const hasFallenBack = useRef(false);

  useEffect(() => {
    if (!visible) return;
    hasFallenBack.current = false;
    setLoadState("downloading");
    setHtmlSource(null);
    setErrorMsg("");

    let cancelled = false;
    (async () => {
      try {
        const cacheDir = FileSystem.Paths.cache.uri;
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        const localUri = cacheDir.endsWith("/")
          ? cacheDir + safeName
          : cacheDir + "/" + safeName;

        const headers: Record<string, string> = {};
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

        const downloadRes = await FileSystem.downloadAsync(fileUrl, localUri, { headers });

        if (cancelled) return;

        if (downloadRes.status !== 200) {
          setLoadState("error");
          setErrorMsg("Download failed (status " + downloadRes.status + ").");
          return;
        }

        const fileRef = new FileSystem.File(downloadRes.uri);
        const arrayBuffer = await fileRef.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);

        if (cancelled) return;

        setHtmlSource(buildViewerHtml(base64, format));
        setLoadState("rendering");
      } catch {
        if (cancelled) return;
        setLoadState("error");
        setErrorMsg("Could not load the scan file.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, fileUrl, fileName, format, authToken]);

  function handleMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type: string };
      if (msg.type === "error" && !hasFallenBack.current) {
        hasFallenBack.current = true;
        onClose();
        onFallback();
      }
    } catch {
    }
  }

  function handleFallback() {
    if (!hasFallenBack.current) {
      hasFallenBack.current = true;
      onClose();
      onFallback();
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar barStyle="light-content" backgroundColor="#18181b" />
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {fileName}
          </Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
            hitSlop={12}
          >
            <Ionicons name="close" size={22} color="#f4f4f5" />
          </Pressable>
        </View>

        {/* Content */}
        <View style={styles.webviewContainer}>
          {loadState === "downloading" && (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#a1a1aa" />
              <Text style={styles.statusText}>Downloading…</Text>
            </View>
          )}

          {loadState === "error" && (
            <View style={styles.center}>
              <Ionicons name="alert-circle-outline" size={48} color="#f87171" />
              <Text style={styles.errorText}>{errorMsg || "Could not load the scan file."}</Text>
              <Pressable
                style={({ pressed }) => [styles.fallbackBtn, pressed && { opacity: 0.7 }]}
                onPress={handleFallback}
              >
                <Ionicons name="share-outline" size={16} color="#fff" />
                <Text style={styles.fallbackBtnText}>Open with another app</Text>
              </Pressable>
            </View>
          )}

          {loadState === "rendering" && htmlSource != null && (
            <WebView
              style={styles.webview}
              source={{ html: htmlSource }}
              originWhitelist={["*"]}
              javaScriptEnabled
              scrollEnabled={false}
              onMessage={handleMessage}
              onError={() => {
                setLoadState("error");
                setErrorMsg("The viewer failed to load.");
              }}
              onHttpError={() => {
                setLoadState("error");
                setErrorMsg("The viewer failed to load.");
              }}
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              bounces={false}
              overScrollMode="never"
            />
          )}
        </View>

        {/* Bottom action */}
        {loadState === "rendering" && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 4 }]}>
            <Pressable
              style={({ pressed }) => [styles.shareBtn, pressed && { opacity: 0.7 }]}
              onPress={handleFallback}
            >
              <Ionicons name="share-outline" size={16} color="#a1a1aa" />
              <Text style={styles.shareBtnText}>Open with another app</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#18181b",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  title: {
    flex: 1,
    color: "#f4f4f5",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtnPressed: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  webviewContainer: {
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
    gap: 12,
    paddingHorizontal: 32,
  },
  statusText: {
    color: "#a1a1aa",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  errorText: {
    color: "#f87171",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  fallbackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#3f3f46",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 4,
  },
  fallbackBtnText: {
    color: "#fff",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
  },
  shareBtnText: {
    color: "#a1a1aa",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
});
