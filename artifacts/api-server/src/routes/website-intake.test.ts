import express from "express";
import request from "supertest";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createWebsiteIntakeRouter, type WebsiteIntakeDependencies } from "./website-intake";
import type { WebsiteIntakeReceipt } from "../lib/website-intake-contract";

const token = "s".repeat(40);
const pdf = Buffer.from("%PDF-1.7\nsynthetic work order\n%%EOF");
const stl = Buffer.alloc(134); stl.writeUInt32LE(1,80);
const ply = Buffer.from("ply\nformat ascii 1.0\nelement vertex 0\nend_header\n");
async function payload() {
  const png = await sharp(Buffer.from('<svg width="240" height="70"><path d="M10 40 L50 15 L75 55 L180 20" stroke="black" stroke-width="4" fill="none"/></svg>')).png().toBuffer();
  return {submissionId:"11111111-1111-4111-8111-111111111111",doctorName:"Synthetic Doctor",licenseNumber:"TEST-123",address:"Test practice address",phone:"8505550100",email:"test@example.invalid",patientName:"Synthetic Patient",caseType:"Crown & Bridge",caseSubtype:"Crown",material:"Zirconia",shade:"A2",instructions:"Synthetic only",signature:`data:image/png;base64,${png.toString("base64")}`,selectedArches:[],teeth:[{tooth:4,restoration:"Crown",material:"Zirconia",shade:"A2"}]};
}
function harness() {
  const config={enabled:true,token,labOrganizationId:"lab-test",uploaderId:"uploader-test"};
  let saved: {fingerprint:string;receipt:WebsiteIntakeReceipt}|null=null;
  const rows: any[]=[]; const stored: any[]=[];
  const scan=vi.fn(async()=>{}); const store=vi.fn(async(file:any,key:string)=>{stored.push({file,key});});
  const dependencies:WebsiteIntakeDependencies={config:()=>config,ready:vi.fn(async()=>{}),scan,store,
    transaction:async(_lab,_id,work)=>{
      const pending:any[]=[];let pendingReceipt:typeof saved=null;
      const result=await work({find:async()=>saved,insert:async(row)=>{const id=`document-${rows.length+pending.length+1}`;pending.push({...row,id});return id;},save:async(fingerprint,receipt)=>{pendingReceipt={fingerprint,receipt};}});
      rows.push(...pending);if(pendingReceipt)saved=pendingReceipt;return result;
    }
  };
  const app=express();app.set("trust proxy",1);app.use("/api/lab-inbox",createWebsiteIntakeRouter(dependencies));
  const send=(data:any,options:{auth?:string;lab?:string;source?:string;secure?:boolean;upper?:Buffer}={})=>{
    const agent=request(app).post("/api/lab-inbox/public-intake");
    if(options.secure!==false)agent.set("X-Forwarded-Proto","https");
    agent.set("Authorization",`Bearer ${options.auth??token}`).set("Idempotency-Key",data.submissionId);
    return agent.field("payload",JSON.stringify(data)).field("labOrganizationId",options.lab??"lab-test").field("source",options.source??"sdrdl.com").attach("prescription",pdf,"signed.pdf").attach("files[0]",options.upper??stl,"upper.stl").attach("files[1]",ply,"lower.ply");
  };
  return {app,send,config,dependencies,scan,store,rows,stored};
}
describe("isolated SDR website receiving route",()=>{
  it("is disabled by default and gates config, bearer and HTTPS before accepting files",async()=>{
    const h=harness();const p=await payload();h.config.enabled=false;
    expect((await h.send(p)).status).toBe(503);expect(h.scan).not.toHaveBeenCalled();
    h.config.enabled=true;expect((await h.send(p,{auth:"wrong"})).status).toBe(401);
    expect((await h.send(p,{secure:false})).status).toBe(403);expect(h.rows).toHaveLength(0);
  });
  it("binds the caller to one fixed lab and approved source",async()=>{
    const h=harness();const p=await payload();
    expect((await h.send(p,{lab:"another-lab"})).status).toBe(403);
    expect((await h.send(p,{source:"another-site"})).status).toBe(400);expect(h.rows).toHaveLength(0);
  });
  it("scans and durably stores every original before acknowledging separate unassigned rows",async()=>{
    const h=harness();const result=await h.send(await payload());
    expect(result.status).toBe(201);expect(result.body).toMatchObject({ok:true,submissionId:"11111111-1111-4111-8111-111111111111",prescriptionDocumentId:"document-1",supportingDocumentIds:["document-2","document-3"]});
    expect(h.scan).toHaveBeenCalledTimes(3);expect(h.store).toHaveBeenCalledTimes(3);expect(h.rows).toHaveLength(3);
    expect(h.rows.map(r=>r.originalFilename)).toEqual(["signed.pdf","upper.stl","lower.ply"]);
    expect(new Set(h.rows.map(r=>r.storagePath)).size).toBe(3);
    expect(h.rows.every(r=>r.labOrganizationId==="lab-test"&&r.uploadedByUserId==="uploader-test"&&r.objectStorageKey===r.storagePath)).toBe(true);
  });
  it("replays the exact receipt after a lost HTTP response without duplicate documents",async()=>{
    const h=harness();const p=await payload();const first=await h.send(p);const retry=await h.send(p);
    expect(retry.status).toBe(200);expect(retry.body).toEqual(first.body);expect(h.rows).toHaveLength(3);expect(h.store).toHaveBeenCalledTimes(3);
  });
  it("rejects changed fields or same-size replacement bytes under the same reference",async()=>{
    const h=harness();const p=await payload();await h.send(p);
    expect((await h.send({...p,shade:"B1"})).status).toBe(409);
    const changed=Buffer.from(stl);changed[90]=1;
    expect((await h.send(p,{upper:changed})).status).toBe(409);expect(h.rows).toHaveLength(3);
  });
  it("leaves no receipt or inbox rows after scan or durable-storage failures and permits a retry",async()=>{
    const h=harness();const p=await payload();h.scan.mockRejectedValueOnce(new Error("scanner unavailable"));
    expect((await h.send(p)).status).toBe(503);expect(h.rows).toHaveLength(0);expect(h.store).not.toHaveBeenCalled();
    h.store.mockRejectedValueOnce(new Error("storage unavailable"));expect((await h.send(p)).status).toBe(503);expect(h.rows).toHaveLength(0);
    expect((await h.send(p)).status).toBe(201);expect(h.rows).toHaveLength(3);
  });
  it("rejects unsigned/invalid chart data and active content renamed as a scan",async()=>{
    const h=harness();const p=await payload();
    expect((await h.send({...p,signature:""})).status).toBe(400);
    expect((await h.send({...p,teeth:[{tooth:33,restoration:"Crown"}]})).status).toBe(400);
    expect((await h.send(p,{upper:Buffer.from("<script>not a scan</script>")})).status).toBe(415);
    expect(h.rows).toHaveLength(0);
  });
  it("fails closed when lab/uploader or storage/scanner readiness is not verified",async()=>{
    const h=harness();h.dependencies.ready=vi.fn(async()=>{throw new Error("not ready");});
    expect((await h.send(await payload())).status).toBe(503);expect(h.rows).toHaveLength(0);expect(h.scan).not.toHaveBeenCalled();
  });
});
