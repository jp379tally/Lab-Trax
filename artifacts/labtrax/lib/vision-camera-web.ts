/**
 * Web-only compatibility layer for react-native-vision-camera.
 *
 * VisionCamera is a native-only module and throws while its package is
 * evaluated in a browser bundle. Metro maps the package to this file only for
 * the web platform so route discovery can safely include scanner screens.
 * Native platforms continue to resolve the real package.
 */

export function Camera(_props: Record<string, unknown>): null {
  return null;
}

export function useCameraDevice(
  _position: "back" | "front" | "external" = "back",
): undefined {
  return undefined;
}

export function useCameraFormat(
  _device: unknown,
  _filters: readonly Record<string, unknown>[] = [],
): undefined {
  return undefined;
}

export function useCameraPermission() {
  return {
    hasPermission: false,
    requestPermission: async () => false,
  } as const;
}

export function useCodeScanner<T extends Record<string, unknown>>(config: T): T {
  return config;
}