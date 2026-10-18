import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AuthedImage } from "./AuthedImage";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;

function boundX(scale: number, width: number): number {
  "worklet";
  return (width * (scale - 1)) / 2;
}

function boundY(scale: number, height: number): number {
  "worklet";
  return (height * (scale - 1)) / 2;
}

function clamp(value: number, bound: number): number {
  "worklet";
  return Math.max(-bound, Math.min(bound, value));
}

/**
 * Lightbox-only interaction. Keep thumbnails on AuthedImage; this component
 * deliberately uses the same authenticated cache and release lifecycle.
 * Mount with a photo-identity key so both the transform and local dimensions
 * are fresh when gallery navigation changes the photo.
 */
export function ZoomableAuthedImage({
  url,
  style,
  testID,
  onLongPress,
}: {
  url: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onLongPress?: () => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const gestures = useMemo(() => {
    // Bounds are relative to the displayed image frame. At fit scale, panning
    // cannot move the photo; at larger scales it cannot be dragged off-screen.
    const pinch = Gesture.Pinch()
      .onStart(() => {
        startScale.value = scale.value;
        startX.value = offsetX.value;
        startY.value = offsetY.value;
      })
      .onUpdate((event) => {
        const next = Math.max(1, Math.min(MAX_SCALE, startScale.value * event.scale));
        const ratio = next / startScale.value;
        // Preserve the point under the fingers rather than zooming only from
        // the middle of the screen.
        offsetX.value = clamp(startX.value * ratio + (1 - ratio) * (event.focalX - size.width / 2), boundX(next, size.width));
        offsetY.value = clamp(startY.value * ratio + (1 - ratio) * (event.focalY - size.height / 2), boundY(next, size.height));
        scale.value = next;
      })
      .onEnd(() => {
        if (scale.value <= 1) {
          offsetX.value = withTiming(0);
          offsetY.value = withTiming(0);
        }
      });

    const pan = Gesture.Pan()
      .maxPointers(1)
      .onStart(() => {
        startX.value = offsetX.value;
        startY.value = offsetY.value;
      })
      .onUpdate((event) => {
        if (scale.value <= 1) return;
        offsetX.value = clamp(startX.value + event.translationX, boundX(scale.value, size.width));
        offsetY.value = clamp(startY.value + event.translationY, boundY(scale.value, size.height));
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd((event, success) => {
        if (!success) return;
        const next = scale.value > 1 ? 1 : DOUBLE_TAP_SCALE;
        offsetX.value = withTiming(next === 1 ? 0 : clamp((1 - next) * (event.x - size.width / 2), boundX(next, size.width)));
        offsetY.value = withTiming(next === 1 ? 0 : clamp((1 - next) * (event.y - size.height / 2), boundY(next, size.height)));
        scale.value = withTiming(next);
      });

    return Gesture.Simultaneous(pinch, pan, doubleTap);
  }, [size.width, size.height, scale, offsetX, offsetY, startScale, startX, startY]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: offsetX.value },
      { translateY: offsetY.value },
      { scale: scale.value },
    ],
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  };

  return (
    <View style={[styles.frame, style]} onLayout={onLayout} testID={testID ? `${testID}-frame` : undefined}>
      <GestureDetector gesture={gestures}>
        <Animated.View style={[styles.fill, animatedStyle]}>
          <Pressable
            style={styles.fill}
            onPress={(event) => event.stopPropagation()}
            onLongPress={onLongPress}
            testID={testID ? `${testID}-touch` : undefined}
          >
            <AuthedImage url={url} style={styles.fill} contentFit="contain" testID={testID} />
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden" },
  fill: { width: "100%", height: "100%" },
});