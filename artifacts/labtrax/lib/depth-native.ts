import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

export interface DepthExtraction {
  ok: boolean;
  json?: string;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  intrinsics?: { fx: number; fy: number; cx: number; cy: number; referenceWidth: number; referenceHeight: number };
  reason?: string;
}

type NativeDepth = {
  isAvailable?: () => boolean;
  extractDepthData?: (photoPath: string, outputPath?: string, maxDimension?: number) => Promise<DepthExtraction>;
};

function nativeModule(): NativeDepth | null {
  if (Platform.OS !== "ios") return null;
  try {
    // Local Expo modules are unavailable in Expo Go and on unsupported builds.
    return requireOptionalNativeModule<NativeDepth>("LabTraxDepth");
  } catch {
    return null;
  }
}

export function depthCapability(): { available: boolean; label: string } {
  const module = nativeModule();
  const available = !!module && (module.isAvailable?.() ?? true);
  return { available, label: available ? "Depth auxiliary capture available" : "Camera-only capture" };
}

export async function extractDepthData(photoUri: string, outputUri: string, maxDimension = 128): Promise<DepthExtraction> {
  const module = nativeModule();
  if (!module?.extractDepthData) return { ok: false, reason: "native-module-unavailable" };
  try {
    return await module.extractDepthData(photoUri, outputUri, maxDimension);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "depth-extraction-failed" };
  }
}