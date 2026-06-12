import { Stack } from "expo-router";

export default function AiReaderLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
      <Stack.Screen name="capture" />
      <Stack.Screen name="review" />
      <Stack.Screen name="extracted" />
      <Stack.Screen name="barcode" />
    </Stack>
  );
}
