import type { PrintDocument } from "./print";

/** Reserve synchronously in the click handler, before fetching anything. */
export function reserveBatchPrintWindow(): Window {
  const win = window.open("", "_blank", "popup=yes,width=900,height=1000");
  if (!win) throw new Error("Print window blocked. Allow pop-ups for LabTrax, then try again.");
  win.document.body.textContent = "Preparing selected documents…";
  return win;
}

const BATCH_CSS = `
@page { size: letter; margin: 0; }
html, body { margin: 0; padding: 0; }
.lt-batch-document + .lt-batch-document { break-before: page; }
.lt-batch-document { display: flow-root; overflow-wrap: anywhere; }
.lt-batch-document.lt-ov-page { padding: .55in; }
.lt-batch-continuation { break-before: page; padding: .55in; }
.lt-batch-continuation .lt-adv-box { position: static; width: auto !important;
 height: auto !important; overflow: visible; margin-bottom: 16px; }
.lt-batch-continuation .lt-inv-table td { white-space: normal; overflow: visible; text-overflow: clip; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
`;

export function batchLabSlipHtml(documents: PrintDocument[]): string {
  if (!documents.length) throw new Error("No lab slips to print.");
  // Renderer CSS is trusted application code; bodies escape server data.
  return `<!doctype html><html><head><title>Selected Lab Slips</title><style>${
    [...new Set(documents.map((doc) => doc.extraCss ?? ""))].join("\n")
  }${BATCH_CSS}</style></head><body>${documents.map((doc) =>
    `<section class="lt-batch-document ${doc.bodyClass ?? ""}">${doc.body}</section>`,
  ).join("")}</body></html>`;
}

function moveOverflowToContinuation(win: Window) {
  for (const page of win.document.querySelectorAll<HTMLElement>(".lt-adv-page")) {
    let continuation: HTMLElement | undefined;
    for (const box of page.querySelectorAll<HTMLElement>(".lt-adv-box")) {
      if (box.querySelector("svg, img, .lt-adv-barcode-bars")) continue;
      if (box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1) continue;
      if (!continuation) {
        continuation = win.document.createElement("div");
        continuation.className = "lt-batch-continuation";
        page.after(continuation);
      }
      const copy = box.cloneNode(true) as HTMLElement;
      // Retain the template's typography, but replace fixed geometry with
      // flowing continuation content so a long block cannot overlap its peers.
      copy.style.position = "static";
      copy.style.removeProperty("left");
      copy.style.removeProperty("top");
      copy.style.width = "auto";
      copy.style.height = "auto";
      copy.style.overflow = "visible";
      continuation.appendChild(copy);
      const caption = box.querySelector(".lt-el-cap")?.textContent ?? "";
      box.textContent = `${caption} — see following pages`;
    }
  }
}

/** One dialog, with cleanup on afterprint (including cancellation) or close. */
export async function printBatchInWindow(win: Window, content: Blob | PrintDocument[]): Promise<void> {
  let url: string | undefined;
  let poll: number | undefined;
  let timeout: number | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (poll) window.clearInterval(poll);
    if (timeout) window.clearTimeout(timeout);
    if (url) URL.revokeObjectURL(url);
    if (!win.closed) win.close();
    finish();
  };
  try {
    if (win.closed) throw new Error("Print window was closed. Select Print again when ready.");
    if (content instanceof Blob) {
      url = URL.createObjectURL(content);
      win.document.body.innerHTML = "";
      const frame = win.document.createElement("iframe");
      frame.style.cssText = "width:100%;height:100vh;border:0";
      const loaded = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("PDF did not load. Retry printing.")), 30_000);
        frame.onload = () => { window.clearTimeout(timer); resolve(); };
        frame.onerror = () => { window.clearTimeout(timer); reject(new Error("PDF could not load. Retry printing.")); };
      });
      frame.src = url;
      win.document.body.appendChild(frame);
      await loaded;
      if (win.closed || !frame.contentWindow) throw new Error("Print window closed. Retry printing.");
      frame.contentWindow.addEventListener("afterprint", cleanup, { once: true });
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } else {
      win.document.open();
      win.document.write(batchLabSlipHtml(content));
      win.document.close();
      await win.document.fonts?.ready;
      await Promise.all(Array.from(win.document.images, (image) => {
        if (image.complete) {
          if (!image.naturalWidth) throw new Error("A lab-slip image failed to load. Retry printing.");
          return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("A lab-slip image timed out. Retry printing.")), 30_000);
          image.onload = () => { window.clearTimeout(timer); resolve(); };
          image.onerror = () => { window.clearTimeout(timer); reject(new Error("A lab-slip image failed to load. Retry printing.")); };
        });
      }));
      moveOverflowToContinuation(win);
      win.addEventListener("afterprint", cleanup, { once: true });
      win.focus();
      win.print();
    }
    // print may return before the native dialog closes. Also handle closing the
    // window manually and browsers that do not dispatch afterprint.
    if (!win.closed) {
      poll = window.setInterval(() => { if (win.closed) cleanup(); }, 500);
      timeout = window.setTimeout(cleanup, 5 * 60_000);
    } else cleanup();
    await finished;
  } catch (error) {
    cleanup();
    throw error;
  }
}
