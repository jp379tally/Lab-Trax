export type PageFilter = "none" | "bw" | "enhance" | "color";

export interface InkPath {
  d: string;
  color: string;
  width: number;
}

export interface TextOverlay {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
}

export interface PageEdit {
  uri: string;
  rotation: 0 | 90 | 180 | 270;
  filter: PageFilter;
  inkPaths: InkPath[];
  texts: TextOverlay[];
}

export function makePageEdit(uri: string): PageEdit {
  return { uri, rotation: 0, filter: "none", inkPaths: [], texts: [] };
}

export function rotateBy90(rotation: number): 0 | 90 | 180 | 270 {
  const next = ((rotation + 90) % 360 + 360) % 360;
  return (next as 0 | 90 | 180 | 270);
}

export function reorderArray<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) {
    return arr;
  }
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function pageNeedsBake(p: PageEdit): boolean {
  return p.filter !== "none" || p.inkPaths.length > 0 || p.texts.length > 0;
}

export function clampNormalizedPoint(x: number, y: number) {
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
}

export function colorMatrixForFilter(filter: PageFilter): number[] | null {
  if (filter === "bw") {
    return [
      0.299, 0.587, 0.114, 0, 0,
      0.299, 0.587, 0.114, 0, 0,
      0.299, 0.587, 0.114, 0, 0,
      0,     0,     0,     1, 0,
    ];
  }
  if (filter === "enhance") {
    return [
      1.35, 0,    0,    0, -25,
      0,    1.35, 0,    0, -25,
      0,    0,    1.35, 0, -25,
      0,    0,    0,    1, 0,
    ];
  }
  if (filter === "color") {
    return [
      1.15, 0,    0,    0, 0,
      0,    1.15, 0,    0, 0,
      0,    0,    1.15, 0, 0,
      0,    0,    0,    1, 0,
    ];
  }
  return null;
}

export const FILTER_LABELS: Record<PageFilter, string> = {
  none: "Original",
  bw: "B&W",
  enhance: "Enhance",
  color: "Color",
};
