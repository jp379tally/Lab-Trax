import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

export const WEBSITE_FILE_LIMIT = 200 * 1024 * 1024;
export const WEBSITE_TOTAL_LIMIT = 500 * 1024 * 1024;
export class WebsiteIntakeError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
const requiredText = z.string().trim().min(1).max(1000);
const tooth = z.object({ tooth:z.number().int().min(1).max(32), restoration:z.string().trim().min(1).max(120), material:z.string().max(200).optional().default(""), shade:z.string().max(80).optional().default("") });
const workOrder = z.object({
  submissionId:z.string().uuid(), doctorName:requiredText, licenseNumber:requiredText,
  address:requiredText, phone:requiredText, email:z.string().trim().email().max(320), patientName:requiredText,
  caseType:requiredText, caseSubtype:requiredText, material:requiredText, shade:z.string().max(80).optional().default(""),
  instructions:z.string().max(12000).optional().default(""), signature:z.string().max(710000),
  selectedArches:z.array(z.enum(["upper","lower"])).max(2).optional().default([]), teeth:z.array(tooth).min(1).max(32),
});
export type WebsiteWorkOrder = z.infer<typeof workOrder>;
export interface WebsiteIntakeReceipt { ok:true; submissionId:string; prescriptionDocumentId:string; supportingDocumentIds:string[]; }
export interface WebsiteUpload { path:string; originalFilename:string; fieldname:string; sizeBytes:number; mimeType:string; sha256:string; }

export async function parseWebsiteWorkOrder(raw: string): Promise<WebsiteWorkOrder> {
  let parsed:unknown;
  try { if (typeof raw!=="string" || Buffer.byteLength(raw)>768*1024) throw new Error(); parsed=JSON.parse(raw); }
  catch { throw new WebsiteIntakeError(400,"The prescription data is invalid or too large."); }
  const result=workOrder.safeParse(parsed);
  if(!result.success) throw new WebsiteIntakeError(400,"Complete the doctor, patient, case and signature fields.");
  const data=result.data;const selected=new Set(data.teeth.map(t=>t.tooth));
  if(selected.size!==data.teeth.length || new Set(data.selectedArches).size!==data.selectedArches.length) throw new WebsiteIntakeError(400,"The tooth or arch selection is invalid.");
  for(const arch of data.selectedArches) for(let n=arch==="upper"?1:17;n<=(arch==="upper"?16:32);n++) if(!selected.has(n)) throw new WebsiteIntakeError(400,"A complete arch must include all sixteen teeth.");
  try {
    if(!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.signature)) throw new Error();
    const image=Buffer.from(data.signature.slice(22),"base64");
    if(image.length>512*1024) throw new Error();
    const decoder=sharp(image,{limitInputPixels:4_000_000});const meta=await decoder.metadata();
    if(meta.format!=="png" || !meta.width || !meta.height || meta.width>8192 || meta.height>4096 || (meta.pages??1)>1) throw new Error();
    const pixels=await decoder.toColourspace("srgb").ensureAlpha().raw().toBuffer();let ink=0;
    for(let i=0;i<pixels.length && ink<20;i+=4) if(pixels[i+3]!>32 && Math.min(pixels[i]!,pixels[i+1]!,pixels[i+2]!)<240) ink++;
    if(ink<20) throw new Error();
  } catch { throw new WebsiteIntakeError(400,"A visible, drawn doctor signature is required."); }
  return data;
}

export function safeOriginalName(value: string): string {
  if(typeof value!=="string" || !value.trim() || value.length>180 || /[\\/\x00-\x1f\x7f]/.test(value) || value==="." || value==="..") throw new WebsiteIntakeError(400,"One filename is invalid.");
  return value.normalize("NFC").trim();
}
export async function inspectWebsiteFile(file: Pick<Express.Multer.File,"path"|"originalname"|"fieldname"|"size">, prescription=false, signal?:AbortSignal): Promise<WebsiteUpload> {
  const name=safeOriginalName(file.originalname);const extension=path.extname(name).toLowerCase();
  const info=await stat(file.path);
  if(!info.isFile() || info.size!==file.size || !info.size || info.size>WEBSITE_FILE_LIMIT || (prescription && info.size>15*1024*1024)) throw new WebsiteIntakeError(413,"One file is empty, too large, or incomplete.");
  const fd=await open(file.path,"r");let head:Buffer;let tail:Buffer;
  try {
    head=Buffer.alloc(Math.min(65536,info.size));await fd.read(head,0,head.length,0);
    tail=Buffer.alloc(Math.min(65536,info.size));await fd.read(tail,0,tail.length,info.size-tail.length);
  } finally { await fd.close(); }
  const text=head.toString("utf8");const end=tail.toString("utf8");let mimeType="";
  if(extension===".pdf" && head.subarray(0,5).toString("ascii")==="%PDF-") mimeType="application/pdf";
  if([".jpg",".jpeg"].includes(extension) && head[0]===255 && head[1]===216 && head[2]===255) mimeType="image/jpeg";
  if(extension===".png" && head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mimeType="image/png";
  if([".heic",".heif",".mp4",".mov"].includes(extension) && head.length>=12 && head.subarray(4,8).toString("ascii")==="ftyp") {
    const brand=head.subarray(8,12).toString("ascii");
    if([".heic",".heif"].includes(extension) && ["heic","heix","hevc","hevx","mif1","msf1"].includes(brand)) mimeType=extension===".heic"?"image/heic":"image/heif";
    if([".mp4",".mov"].includes(extension) && ["isom","iso2","iso4","iso5","iso6","mp41","mp42","avc1","M4V ","MSNV","qt  "].includes(brand)) mimeType=extension===".mov"?"video/quicktime":"video/mp4";
  }
  if(extension===".dcm" && head.subarray(128,132).toString("ascii")==="DICM") mimeType="application/dicom";
  if(extension===".ply" && /^ply\r?\nformat (ascii|binary_little_endian|binary_big_endian) 1\.0\r?\n/.test(text) && /\r?\nend_header\r?\n/.test(text)) mimeType="model/ply";
  if(extension===".stl") {
    const binary=head.length>=84 && info.size===84+head.readUInt32LE(80)*50;
    const ascii=/^\s*solid(?:\s|$)/i.test(text) && /\bfacet\s+normal\b/i.test(text) && /\bvertex\s+[-+\d.]/i.test(text) && /\bendsolid\b/i.test(end);
    if(binary||ascii) mimeType="model/stl";
  }
  if(extension===".obj" && !/[\x00]|<\s*(html|script|!doctype)/i.test(text) && /(?:^|\n)\s*v\s+[-+\d.]/.test(text) && /(?:^|\n)\s*f\s+[\d+-]/.test(text+"\n"+end)) mimeType="model/obj";
  if(!mimeType || (prescription && mimeType!=="application/pdf")) throw new WebsiteIntakeError(415,"A file's contents do not match a supported format.");
  const digest=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(file.path,{signal})) { bytes+=chunk.length;digest.update(chunk); }
  if(bytes!==info.size) throw new WebsiteIntakeError(400,"A file changed while being verified.");
  return {path:file.path,fieldname:file.fieldname,originalFilename:name,mimeType,sizeBytes:bytes,sha256:digest.digest("hex")};
}
export function fingerprintSubmission(raw: string, files: WebsiteUpload[]): string {
  return createHash("sha256").update(raw).update(JSON.stringify(files.map(f=>[f.originalFilename,f.sizeBytes,f.mimeType,f.sha256]))).digest("hex");
}
