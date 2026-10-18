import { IMPLANT_FIELDS } from "./implant-details";

export interface SlipElement {
  id: string; kind: string; x: number; y: number; w: number; h: number; visible: boolean;
  fontFamily?: string; fontSize?: number; bold?: boolean; italic?: boolean; align?: string;
  opacity?: number; url?: string; storageKey?: string;
  page?: number;
  showPracticeName?: boolean; showAddress?: boolean; showPhone?: boolean; showEmail?: boolean;
  showColumns?: string[];
}
export interface SlipTemplate { version: number; elements: SlipElement[] }
export const IMPLANT_FIELD_LABELS = {
  implantRetention: "Implant Retention",
  implantManufacturer: "Implant Manufacturer",
  implantPlatformNotes: "Implant Platform Notes",
};
/** New fields never displace a lab's existing custom boxes. If their default
 * region is occupied, the renderer puts their content on continuation pages. */
export function withImplantElements<T extends SlipElement>(elements: T[]): T[] {
  return [...elements, ...IMPLANT_FIELDS.filter((kind) => !elements.some((el) => el.kind === kind)).map((kind, index) => ({
    id: kind, kind, x: 48, y: 48 + index * 72, w: 720, h: 68, visible: true, page: 2,
    fontFamily: "Helvetica, Arial, sans-serif", fontSize: 13, bold: false, italic: false, align: "left",
  } as T))];
}
export function escapeSlipHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** A single UTC calendar date format shared by mobile, desktop, and print. */
export function formatRxNoteScanDate(value: string | Date | null | undefined): string {
  if (!value) return "Date unknown";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unknown";
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}
export const SHARED_SLIP_CSS = `
@page { size: letter; margin: 0; }
* { box-sizing: border-box; }
.lt-adv-page { width:816px; height:1056px; position:relative; color:#111; page-break-after:always; }
.lt-adv-page:last-child { page-break-after:auto; }
.lt-adv-box { position:absolute; padding:6px; overflow:hidden; }
.lt-el-cap { font-size:10px; font-weight:600; text-transform:uppercase; color:#555; margin-bottom:4px; }
.lt-el-val { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.4; }
.lt-slip-continuation { break-before:page; padding:48px; color:#111; }
.lt-slip-continuation .lt-adv-box { position:static; width:auto; height:auto; overflow:visible; margin-bottom:18px; }
.lt-slip-continuation .lt-el-val { white-space:pre-wrap; overflow-wrap:anywhere; }
.lt-slip-continuation table { width:100%; border-collapse:collapse; }
.lt-slip-continuation td { white-space:normal; overflow-wrap:anywhere; }
.lt-rx-note-history { display:grid; gap:8px; }
.lt-rx-note-row { display:grid; grid-template-columns:82px minmax(0,1fr); gap:8px; align-items:start; break-inside:avoid; }
.lt-rx-note-date { color:#555; font-size:10px; white-space:nowrap; }
.lt-rx-note-text { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
`;
function typography(el: SlipElement) {
  return `font-family:${escapeSlipHtml(el.fontFamily || "Helvetica, Arial, sans-serif")};font-size:${el.fontSize ?? 13}px;font-weight:${el.bold ? 700 : 400};font-style:${el.italic ? "italic" : "normal"};text-align:${el.align || "left"}`;
}
function exceedsBox(text: string, el: SlipElement): boolean {
  // Conservative estimate works without a browser DOM (including expo-print).
  // Keep complete text in a flowing continuation; never truncate clinical data.
  const fs = el.fontSize ?? 13;
  const columns = Math.max(1, Math.floor((el.w - 12) / (fs * 0.75)));
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
  return lines * fs * 1.5 + 30 > el.h;
}
export interface SlipContent { caption?: string; text?: string; html?: string; graphic?: boolean }
/** Shared geometry, typography, escaping and continuation policy for web and native PDF. */
export function renderSharedSlip(template: SlipTemplate, content: (el: SlipElement) => SlipContent | null): string {
  const fixed = new Map<number, string[]>();
  const continued: string[] = [];
  for (const el of template.elements) {
    if (!el.visible) continue;
    const item = content(el);
    if (!item) continue;
    const caption = item.caption ? `<div class="lt-el-cap">${escapeSlipHtml(item.caption)}</div>` : "";
    const inner = `${caption}${item.html ?? `<div class="lt-el-val">${escapeSlipHtml(item.text)}</div>`}`;
    const implant = (IMPLANT_FIELDS as readonly string[]).includes(el.kind);
    const overlaps = implant && template.elements.some((other) => other.visible && other.id !== el.id &&
      !(IMPLANT_FIELDS as readonly string[]).includes(other.kind) &&
      (other.page ?? 1) === (el.page ?? 1) &&
      el.x < other.x + other.w && el.x + el.w > other.x && el.y < other.y + other.h && el.y + el.h > other.y);
    const overflow = !item.graphic && (overlaps || el.y + el.h > 1056 || exceedsBox(item.text ?? "", el));
    const style = typography(el);
    if (overflow) continued.push(`<div class="lt-adv-box" style="${style}">${inner}</div>`);
    if (overlaps || el.y + el.h > 1056) continue;
    const page = el.page ?? 1;
    const boxes = fixed.get(page) ?? [];
    boxes.push(`<div class="lt-adv-box" data-kind="${escapeSlipHtml(el.kind)}" style="left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;${style}">${overflow ? `${caption}<div class="lt-el-val">See following pages</div>` : inner}</div>`);
    fixed.set(page, boxes);
  }
  return `${[...fixed.entries()].sort(([a], [b]) => a - b).map(([page, boxes]) => `<div class="lt-adv-page" data-page="${page}">${boxes.join("")}</div>`).join("")}${continued.length ? `<div class="lt-slip-continuation">${continued.join("")}</div>` : ""}`;
}

export function slipToothChart(selected: Set<string>): string {
  const path = "M3 28 Q3 4 11 4 Q19 4 19 28 L18 62 Q14 70 11 62 Q8 70 4 62 Z";
  const rows = [Array.from({ length: 16 }, (_, i) => i + 1), Array.from({ length: 16 }, (_, i) => 32 - i)];
  return `<svg viewBox="0 0 512 210" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">${rows.map((row, rowIndex) => row.map((tooth, column) => {
    const active = selected.has(String(tooth));
    const x = column * 32 + 4;
    return `<path d="${path}" transform="${rowIndex === 0 ? `translate(${x},82) scale(1.09,-1.21)` : `translate(${x},128) scale(1.09,1.21)`}" fill="${active ? "#3b82f6" : "#fff"}" stroke="${active ? "#1e40af" : "#94a3b8"}"/><text x="${column * 32 + 16}" y="${rowIndex === 0 ? 94 : 123}" text-anchor="middle" font-size="12" font-family="Helvetica, Arial" fill="${active ? "#1e40af" : "#334155"}">${tooth}</text>`;
  }).join("")).join("")}</svg>`;
}
