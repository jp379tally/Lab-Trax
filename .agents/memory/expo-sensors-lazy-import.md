---
name: expo-sensors lazy import
description: expo-sensors crashes the app at module load time if requireNativeModule fails; must use dynamic import inside the function that needs it, not a static top-level import.
---

## Rule
Never statically import `expo-sensors` (or any package that calls `requireNativeModule` at module load time) in a screen that's navigated to lazily.

## Why
`expo-sensors/build/ExponentAccelerometer.js` exports:
```js
export default requireNativeModule('ExponentAccelerometer');
```
`requireNativeModule` is called **synchronously at module evaluation time**. When Metro first loads the screen's JS bundle on navigation (lazy load), this runs immediately. If `ExponentAccelerometer` isn't registered as a native module at that instant, it throws — crashing the whole app. The symptom is a hard crash on every press of the nav button, with no visible error.

## How to apply
Use a dynamic `import()` inside the function that actually needs the sensor:

```typescript
async function startAccelerometer() {
  try {
    const { Accelerometer } = await import("expo-sensors");
    Accelerometer.setUpdateInterval(interval);
    subRef.current = Accelerometer.addListener(handler);
  } catch {
    // Sensor unavailable — degrade gracefully
    setAutoShutter(false);
  }
}
```

Type the subscription ref without importing expo-sensors:
```typescript
const subRef = useRef<{ remove: () => void } | null>(null);
```

The cleanup function (`stopAccelerometer`) doesn't need expo-sensors at all — it just calls `subRef.current?.remove()`.

In Metro bundler, dynamic `import()` of a pre-bundled module is effectively synchronous, so there's no meaningful latency penalty.
