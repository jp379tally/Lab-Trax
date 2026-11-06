import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLabInboxIntakeRouter, type InboxIntakeDependencies, type InboxIntakeDocument } from "./lab-inbox-intake";

vi.mock("../middlewares/auth", () => ({ requireAuth: (req: any, res: any, next: any) => {
  if (req.get("Authorization") !== "Bearer fixture-user") return res.status(401).json({ok:false});
  req.auth={userId:"fixture-user"};next();
} }));

function harness() {
  const documents:InboxIntakeDocument[]=[
    {id:"rx",labOrganizationId:"lab-a",originalFilename:"Signed prescription.pdf",mimeType:"application/pdf",sizeBytes:100,storagePath:"rx.pdf",objectStorageKey:"rx.pdf",assignedAt:null,assignedToCaseId:null,note:null},
    {id:"upper",labOrganizationId:"lab-a",originalFilename:"upper.stl",mimeType:"model/stl",sizeBytes:200,storagePath:"upper.stl",objectStorageKey:"upper.stl",assignedAt:null,assignedToCaseId:null,note:null},
    {id:"lower",labOrganizationId:"lab-a",originalFilename:"lower.ply",mimeType:"model/ply",sizeBytes:300,storagePath:"lower.ply",objectStorageKey:"lower.ply",assignedAt:null,assignedToCaseId:null,note:null},
  ];
  let target={id:"case-a",labOrganizationId:"lab-a"};
  const attachments:any[]=[];const events:any[]=[];const operations:string[]=[];
  const groups=[{id:"submission-a",labOrganizationId:"lab-a",documentIds:["rx","upper","lower"],prescriptionDocumentId:"rx"}];
  const authorize=vi.fn(async()=>{});
  const dependencies:InboxIntakeDependencies={authorize,
    documents:async(_lab,ids)=>documents.filter(d=>ids.includes(d.id)),
    groups:async(_lab,ids)=>groups.filter(g=>g.documentIds.some(id=>ids.includes(id))),
    transaction:async work=>{
      const documentSnapshot=structuredClone(documents),attachmentSnapshot=structuredClone(attachments),eventSnapshot=structuredClone(events);
      try {return await work({
        lockCase:async()=>{operations.push("case-lock");return target;},
        lockDocuments:async(_lab,ids)=>{operations.push("documents-lock");return documents.filter(d=>ids.includes(d.id));},
        attachment:async(caseId,sourceId)=>attachments.find(a=>a.caseId===caseId&&a.submissionId===`inbox:${sourceId}`)??null,
        insertAttachment:async row=>{const saved={...row,id:`attachment-${attachments.length+1}`};attachments.push(saved);return saved.id;},
        assign:async(id,caseId)=>{Object.assign(documents.find(d=>d.id===id)!,{assignedAt:new Date(),assignedToCaseId:caseId});},
        event:async row=>{events.push(row);},
      });} catch(error){documents.splice(0,documents.length,...documentSnapshot);attachments.splice(0,attachments.length,...attachmentSnapshot);events.splice(0,events.length,...eventSnapshot);throw error;}
    },
  };
  const app=express();app.use(express.json());app.use("/api/lab-inbox",createLabInboxIntakeRouter(dependencies));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.statusCode??500).json({ok:false,error:error.statusCode?error.message:"Request failed"}));
  const post=(route:string,body:any,authenticated=true)=>{const r=request(app).post(`/api/lab-inbox/${route}`);if(authenticated)r.set("Authorization","Bearer fixture-user");return r.send(body);};
  return {documents,groups,attachments,events,operations,authorize,dependencies,post,setTarget:(value:typeof target)=>{target=value;}};
}

describe("authenticated unassigned-document intake",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("requires a real authenticated entrance and lab authorization",async()=>{
    const h=harness();expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["upper"]},false)).status).toBe(401);
    h.authorize.mockRejectedValueOnce(Object.assign(new Error("Not a member"),{statusCode:403}));
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["upper"]})).status).toBe(403);expect(h.attachments).toHaveLength(0);
  });
  it("expands a scan to its complete website submission, without exposing storage keys",async()=>{
    const h=harness();const result=await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["upper"]});
    expect(result.status).toBe(200);expect(result.body.data.prescriptionDocumentId).toBe("rx");
    expect(result.body.data.documents.map((d:any)=>d.id)).toEqual(["rx","upper","lower"]);
    expect(result.body.data.documents[1]).toEqual({id:"upper",fileName:"upper.stl",mimeType:"model/stl",sizeBytes:200});
    expect(JSON.stringify(result.body)).not.toContain("objectStorageKey");expect(h.attachments).toHaveLength(0);
  });
  it("rejects mixed website submissions and cross-lab or missing documents",async()=>{
    const h=harness();h.groups.push({id:"submission-b",labOrganizationId:"lab-a",documentIds:["other-rx"],prescriptionDocumentId:"other-rx"});
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["upper","other-rx"]})).status).toBe(409);
    h.documents[2].labOrganizationId="lab-b";
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["upper"]})).status).toBe(404);
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["unknown"]})).status).toBe(404);
  });
  it("links each existing original key atomically, without a file copy or upload",async()=>{
    const h=harness();const result=await h.post("assign-batch",{labOrganizationId:"lab-a",caseId:"case-a",documentIds:["upper"]});
    expect(result.status).toBe(200);expect(h.operations).toEqual(["case-lock","documents-lock"]);
    expect(h.attachments.map(a=>a.storageKey)).toEqual(["rx.pdf","upper.stl","lower.ply"]);
    expect(h.attachments.every(a=>a.visibility==="internal_lab_only"&&a.uploadedByOrganizationId==="lab-a")).toBe(true);
    expect(h.documents.every(d=>d.assignedToCaseId==="case-a")).toBe(true);expect(h.events).toHaveLength(3);
  });
  it("replays the same attachment IDs without duplicate case events or attachments",async()=>{
    const h=harness();const body={labOrganizationId:"lab-a",caseId:"case-a",documentIds:["upper"]};
    const first=await h.post("assign-batch",body),retry=await h.post("assign-batch",body);
    expect(retry.status).toBe(200);expect(retry.body).toEqual(first.body);expect(h.attachments).toHaveLength(3);expect(h.events).toHaveLength(3);
    expect((await h.post("assign-batch",{...body,caseId:"case-b"})).status).toBe(409);expect(h.attachments).toHaveLength(3);
  });
  it("rechecks the locked case tenant, rather than trusting an earlier client selection",async()=>{
    const h=harness();h.setTarget({id:"case-a",labOrganizationId:"lab-b"});
    expect((await h.post("assign-batch",{labOrganizationId:"lab-a",caseId:"case-a",documentIds:["rx"]})).status).toBe(403);
    expect(h.attachments).toHaveLength(0);expect(h.documents.every(d=>!d.assignedAt)).toBe(true);
  });
  it("rolls back the entire group if the timeline or assignment cannot be saved",async()=>{
    const h=harness();const original=h.dependencies.transaction;
    h.dependencies.transaction=work=>original(tx=>work({...tx,event:async()=>{throw new Error("database failed");}}));
    expect((await h.post("assign-batch",{labOrganizationId:"lab-a",caseId:"case-a",documentIds:["rx"]})).status).toBe(500);
    expect(h.attachments).toHaveLength(0);expect(h.events).toHaveLength(0);expect(h.documents.every(d=>!d.assignedAt)).toBe(true);
  });
  it("refuses incomplete, oversized, duplicate and note-only inputs",async()=>{
    const h=harness();
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:[]})).status).toBe(400);
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["rx","rx"]})).status).toBe(400);
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:Array.from({length:14},(_,i)=>String(i))})).status).toBe(400);
    h.documents[1].storagePath=null;h.documents[1].objectStorageKey=null;
    expect((await h.post("prepare-intake",{labOrganizationId:"lab-a",documentIds:["upper"]})).status).toBe(409);
  });
});
