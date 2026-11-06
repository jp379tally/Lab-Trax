import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { parseWebsiteWorkOrder, inspectWebsiteFile, fingerprintSubmission } from "./website-intake-contract";

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
export async function exampleWorkOrder(blank = false) {
  const svg = `<svg width="240" height="70"><rect width="240" height="70" fill="white"/>${blank ? "" : '<path d="M10 45 L35 15 L40 55 L75 20 L90 50 L180 25" fill="none" stroke="black" stroke-width="4"/>'}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { submissionId:"11111111-1111-4111-8111-111111111111", doctorName:"Test Doctor", licenseNumber:"TEST-123", address:"Test practice address", phone:"8505550100", email:"test@example.invalid", patientName:"Synthetic Patient", caseType:"Crown & Bridge", caseSubtype:"Crown", material:"Zirconia", shade:"A2", instructions:"Synthetic test only", signature:`data:image/png;base64,${png.toString("base64")}`, selectedArches:[], teeth:[{tooth:4,restoration:"Crown",material:"Zirconia",shade:"A2"}] };
}
async function inspect(name: string, bytes: Buffer, prescription = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "sdr-contract-test-")); scratch.push(dir);
  const target = path.join(dir, "upload"); await writeFile(target, bytes);
  return inspectWebsiteFile({ path:target, originalname:name, size:bytes.length, fieldname:prescription ? "prescription" : "files[0]" }, prescription);
}
describe("website prescription contract", () => {
  it("keeps the doctor, editable clinical fields, tooth and drawn signature", async () => {
    const source = await exampleWorkOrder(); const result = await parseWebsiteWorkOrder(JSON.stringify(source));
    expect(result).toMatchObject({doctorName:"Test Doctor",licenseNumber:"TEST-123",patientName:"Synthetic Patient",teeth:[{tooth:4,restoration:"Crown",material:"Zirconia",shade:"A2"}]});
  });
  it("rejects duplicate, out-of-range and empty tooth selections", async () => {
    const source = await exampleWorkOrder();
    for (const teeth of [[],[source.teeth[0],source.teeth[0]],[{...source.teeth[0],tooth:0}],[{...source.teeth[0],tooth:33}]]) await expect(parseWebsiteWorkOrder(JSON.stringify({...source,teeth}))).rejects.toMatchObject({status:400});
  });
  it("requires all sixteen teeth for a selected complete arch", async () => {
    const source = await exampleWorkOrder();
    await expect(parseWebsiteWorkOrder(JSON.stringify({...source,selectedArches:["upper"]}))).rejects.toMatchObject({status:400});
    const teeth = Array.from({length:16},(_,i)=>({tooth:i+1,restoration:"Full arch",material:"",shade:""}));
    expect((await parseWebsiteWorkOrder(JSON.stringify({...source,selectedArches:["upper"],teeth}))).selectedArches).toEqual(["upper"]);
  });
  it("refuses a blank, corrupt or missing signature and incomplete contact fields", async () => {
    const source = await exampleWorkOrder();
    for (const value of [{...await exampleWorkOrder(true)},{...source,signature:"data:image/png;base64,AAAA"},{...source,signature:""},{...source,email:"not-an-email"},{...source,licenseNumber:""}]) await expect(parseWebsiteWorkOrder(JSON.stringify(value))).rejects.toMatchObject({status:400});
  });
  it("requires an actual PDF for the single signed prescription", async () => {
    expect(await inspect("signed.pdf",Buffer.from("%PDF-1.7\nsynthetic\n%%EOF"),true)).toMatchObject({mimeType:"application/pdf",originalFilename:"signed.pdf"});
    await expect(inspect("signed.pdf",Buffer.from("<html>not PDF</html>"),true)).rejects.toMatchObject({status:415});
  });
  it("accepts original binary STL, ASCII PLY and OBJ files separately", async () => {
    const stl = Buffer.alloc(134);stl.writeUInt32LE(1,80);
    expect(await inspect("upper.stl",stl)).toMatchObject({mimeType:"model/stl"});
    expect(await inspect("lower.ply",Buffer.from("ply\nformat ascii 1.0\nelement vertex 0\nend_header\n"))).toMatchObject({mimeType:"model/ply"});
    expect(await inspect("model.obj",Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"))).toMatchObject({mimeType:"model/obj"});
  });
  it("refuses renamed active content, path traversal and mismatched size evidence", async () => {
    await expect(inspect("scan.stl",Buffer.from("<script>alert(1)</script>"))).rejects.toMatchObject({status:415});
    await expect(inspect("../rx.pdf",Buffer.from("%PDF-1.7\n%%EOF"))).rejects.toMatchObject({status:400});
    await expect(inspect("movie.mp4",Buffer.from("<html>not video</html>"))).rejects.toMatchObject({status:415});
  });
  it("binds receipt identity to all prescription/original bytes, not filenames or sizes", async () => {
    const a = await inspect("rx.pdf",Buffer.from("%PDF-1.7\nAAAA\n%%EOF"),true);
    const b = await inspect("rx.pdf",Buffer.from("%PDF-1.7\nBBBB\n%%EOF"),true);
    expect(a.sizeBytes).toBe(b.sizeBytes); expect(a.sha256).not.toBe(b.sha256);
    expect(fingerprintSubmission("payload",[a])).not.toBe(fingerprintSubmission("payload",[b]));
    expect(fingerprintSubmission("payload",[a])).not.toBe(fingerprintSubmission("changed",[a]));
  });
});
