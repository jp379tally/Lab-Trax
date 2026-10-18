import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import {
  acquireVideoThumbnailUri,
  invalidateVideoThumbnail,
} from "@/lib/video-thumbnail";

interface VideoThumbnailProps {
  url: string;
  tintColor: string;
  fallbackColor: string;
}

export function VideoThumbnail({
  url,
  tintColor,
  fallbackColor,
}: VideoThumbnailProps) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; uri: string }
    | { status: "error" }
  >({ status: "loading" });
  const releaseThumbnailRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let release = () => {};
    setState({ status: "loading" });
    acquireVideoThumbnailUri(url)
      .then((acquired) => {
        if (!cancelled) {
          release = acquired?.release ?? (() => {});
          releaseThumbnailRef.current = release;
          setState(acquired ? { status: "ready", uri: acquired.uri } : { status: "error" });
        } else {
          acquired?.release();
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
      release();
      releaseThumbnailRef.current = () => {};
    };
  }, [url]);

  return (
    <View
      style={[styles.container, { backgroundColor: fallbackColor }]}
      testID="video-thumbnail"
    >
      {state.status === "ready" ? (
        <Image
          source={{ uri: state.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          onError={() => {
            releaseThumbnailRef.current();
            releaseThumbnailRef.current = () => {};
            invalidateVideoThumbnail(url);
            setState({ status: "error" });
          }}
          testID="video-thumbnail-image"
        />
      ) : state.status === "loading" ? (
        <ActivityIndicator color={tintColor} testID="video-thumbnail-loading" />
      ) : (
        <Ionicons
          name="videocam-outline"
          size={30}
          color={tintColor}
          testID="video-thumbnail-fallback"
        />
      )}
      <View style={styles.play} testID="video-thumbnail-play">
        <Ionicons name="play" size={22} color={tintColor} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  play: {
    position: "absolute",
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.58)",
    paddingLeft: 2,
  },
});
