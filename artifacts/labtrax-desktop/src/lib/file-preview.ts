/**
 * Shared in-app preview window for protected files fetched as blobs.
 *
 * Used by every surface that lets a user open a file the API only serves to
 * an authenticated caller (the lab's Unassigned Documents card, the provider
 * portal's Sent list). Keeping one implementation means a PDF opens the same
 * way wherever it is tapped, and no surface regresses into an unwanted
 * automatic download.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Opens a dedicated preview window for a fetched file blob URL.
 * - PDFs render in an <iframe>, images in an <img>.
 * - Unsupported types get a fallback page with an explicit Download button
 *   instead of triggering an automatic download.
 * The caller owns the blob URL lifecycle (do not revoke while the window is open).
 */
export function openFilePreviewWindow(
  blobUrl: string,
  contentType: string,
  filename: string,
): void {
  // No "noopener" here: we need the window handle to write the preview
  // document. The document is same-origin and fully under our control.
  const win = window.open("", "_blank");
  if (!win) {
    // Popup blocked — fall back to opening the blob directly.
    window.open(blobUrl, "_blank");
    return;
  }
  const safeTitle = escapeHtml(filename);
  const isPdf = contentType === "application/pdf";
  const isImage = contentType.startsWith("image/");
  let body: string;
  if (isPdf) {
    body = `<iframe src="${blobUrl}" title="${safeTitle}" style="border:0;width:100vw;height:100vh;display:block"></iframe>`;
  } else if (isImage) {
    body = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a"><img src="${blobUrl}" alt="${safeTitle}" style="max-width:100%;max-height:100vh;object-fit:contain" /></div>`;
  } else {
    body = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;font-family:system-ui,sans-serif;background:#f5f5f5;color:#333">
        <div style="font-size:48px">📎</div>
        <div style="font-size:15px;font-weight:600;max-width:80vw;overflow-wrap:anywhere;text-align:center">${safeTitle}</div>
        <div style="font-size:13px;color:#777">This file type cannot be previewed in the browser.</div>
        <a href="${blobUrl}" download="${safeTitle}" style="padding:8px 20px;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none;font-size:13px;font-weight:600">Download</a>
      </div>`;
  }
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>html,body{margin:0;padding:0}</style></head><body>${body}</body></html>`,
  );
  win.document.close();
}
