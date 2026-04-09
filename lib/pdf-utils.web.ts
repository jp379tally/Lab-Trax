export async function convertPdfToImages(arrayBuffer: ArrayBuffer): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const pageImages: string[] = [];
  const maxPages = Math.min(pdf.numPages, 10);
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const scale = 2.0;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport }).promise;
    const imgDataUri = canvas.toDataURL("image/png");
    pageImages.push(imgDataUri);
  }
  console.log(`PDF converted: ${pageImages.length} page(s) from ${pdf.numPages} total`);
  return pageImages;
}
