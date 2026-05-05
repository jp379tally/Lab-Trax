export async function convertPdfToImages(_arrayBuffer: ArrayBuffer): Promise<string[]> {
  console.log("PDF conversion is disabled on native builds.");
  return [];
}
