import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import { ZoomableAuthedImage } from "../ZoomableAuthedImage";
import { mockZoomSharedValues } from "../../../vitest.setup";

afterEach(() => {
  cleanup();
  mockZoomSharedValues.length = 0;
});

async function mountedPhoto(url = "/api/cases/a/attachments/one/file") {
  mockZoomSharedValues.length = 0;
  const view = await render(<ZoomableAuthedImage url={url} testID="photo" />);
  await fireEvent(view.getByTestId("photo-frame"), "layout", {
    nativeEvent: { layout: { width: 400, height: 600 } },
  });
  const gestures = view.getByTestId("zoom-gesture").props.gesture as Array<{
    start: (event?: any) => void;
    update: (event: any) => void;
    end: (event: any, success?: boolean) => void;
  }>;
  // Each render owns its own transform; the first three values are scale, X, Y.
  const [scale, x, y] = mockZoomSharedValues;
  return { view, gestures, scale: scale!, x: x!, y: y! };
}

describe("ZoomableAuthedImage lightbox gestures", () => {
  it("pinches around the focal point and bounds scale and translation", async () => {
    const { gestures, scale, x, y } = await mountedPhoto();
    await act(() => {
      gestures[0]!.start();
      gestures[0]!.update({ scale: 3, focalX: 300, focalY: 400 });
    });
    expect(scale.value).toBe(3);
    expect(x.value).toBe(-200);
    expect(y.value).toBe(-200);
    await act(() => gestures[0]!.update({ scale: 10, focalX: 300, focalY: 400 }));
    expect(scale.value).toBe(4);
    await act(() => {
      gestures[0]!.start();
      gestures[0]!.update({ scale: 0.1, focalX: 200, focalY: 300 });
      gestures[0]!.end({});
    });
    expect(scale.value).toBe(1);
    expect(x.value).toBe(0);
    expect(y.value).toBe(0);
  });

  it("pans only when enlarged and clamps the image within the frame", async () => {
    const { gestures, scale, x, y } = await mountedPhoto();
    await act(() => {
      gestures[1]!.start();
      gestures[1]!.update({ translationX: 100, translationY: 100 });
    });
    expect(x.value).toBe(0);
    await act(() => gestures[2]!.end({ x: 200, y: 300 }, true));
    expect(scale.value).toBe(2.5);
    await act(() => {
      gestures[1]!.start();
      gestures[1]!.update({ translationX: 999, translationY: -999 });
    });
    expect(x.value).toBe(300);
    expect(y.value).toBe(-450);
  });

  it("double-taps to zoom and reset, then remounts at fit scale for another photo", async () => {
    const { view, gestures, scale, x } = await mountedPhoto();
    await act(() => gestures[2]!.end({ x: 300, y: 300 }, true));
    expect(scale.value).toBe(2.5);
    expect(x.value).toBe(-150);
    await act(() => gestures[2]!.end({ x: 300, y: 300 }, true));
    expect(scale.value).toBe(1);
    expect(x.value).toBe(0);
    await act(() => gestures[2]!.end({ x: 200, y: 300 }, true));
    await view.unmount();
    const next = await mountedPhoto("/api/cases/a/attachments/two/file");
    expect(next.scale.value).toBe(1);
    expect(next.x.value).toBe(0);
    expect(next.y.value).toBe(0);
  });
});