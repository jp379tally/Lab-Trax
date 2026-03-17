import React, { useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { getApiUrl } from "@/lib/query-client";

export default function SmilePreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);

  const smileUrl = (() => {
    const base = getApiUrl();
    try {
      const u = new URL("/smile-preview", base);
      return u.toString();
    } catch {
      return base + "/smile-preview";
    }
  })();

  const handleMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "capture") {
        Alert.alert("Photo Captured", "The smile preview photo has been saved.");
      }
    } catch {}
  };

  if (Platform.OS === "web") {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, 67) }]}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.backBtn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </Pressable>
          <Text style={styles.headerTitle}>Smile Preview</Text>
          <View style={{ width: 40 }} />
        </View>
        <iframe
          src={smileUrl}
          style={{
            flex: 1,
            border: "none",
            width: "100%",
            height: "100%",
          } as any}
          allow="camera"
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.backBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </Pressable>
        <Text style={styles.headerTitle}>Smile Preview</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.loadingText}>Loading Smile Preview...</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        source={{ uri: smileUrl }}
        style={styles.webview}
        onLoadEnd={() => setLoading(false)}
        onMessage={handleMessage}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState={false}
        originWhitelist={["https://*"]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "rgba(0,0,0,0.85)",
    zIndex: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  webview: {
    flex: 1,
    backgroundColor: "#000",
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
    zIndex: 5,
    gap: 12,
  },
  loadingText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 15,
  },
});
