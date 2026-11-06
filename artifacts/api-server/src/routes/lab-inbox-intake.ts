import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { HttpError, ok } from "../lib/http";
import { normalizeInboxStorageName } from "../lib/lab-inbox-storage-repair";

export interface InboxIntakeDocument {
  id:string;labOrganizationId:string;originalFilename:string|null;mimeType:string|null;sizeBytes:number|null;
  storagePath:string|null;objectStorageKey:string|null;note:string|null;
  assignedAt:Date|null;assignedToCaseId:string|null;
}
export interface InboxIntakeGroup {
  id:string;labOrganizationId:string;documentIds:string[];prescriptionDocumentId:string;
}
interface LinkedAttachment { id:string;storageKey:string; }
export interface InboxIntakeTransaction {
  lockCase:(id:string)=>Promise<{id:string;labOrganizationId:string}|null>;
  lockDocuments:(labId:string,ids:string[])=>Promise<InboxIntakeDocument[]>;
  attachment:(caseId:string,sourceId:string)=>Promise<LinkedAttachment|null>;
  insertAttachment:(row:{caseId:string;uploadedByUserId:string;uploadedByOrganizationId:string;fileName:string;storageKey:string;fileType:string;submissionId:string;visibility:"internal_lab_only";note:string|null})=>Promise<string>;
  assign:(id:string,caseId:string,userId:string)=>Promise<void>;
  event:(row:{caseId:string;actorUserId:string;actorOrganizationId:string;attachmentId:string;fileName:string;fileType:string})=>Promise<void>;
}
export interface InboxIntakeDependencies {
  authorize:(userId:string,labId:string)=>Promise<void>;
  documents:(labId:string,ids:string[])=>Promise<InboxIntakeDocument[]>;
  groups:(labId:string,ids:string[])=>Promise<InboxIntakeGroup[]>;
  transaction:<T>(work:(tx:InboxIntakeTransaction)=>Promise<T>)=>Promise<T>;
}
const id=z.string().trim().min(1).max(128);
const requestSchema=z.object({labOrganizationId:id,documentIds:z.array(id).min(1).max(13).refine(ids=>new Set(ids).size===ids.length,"Choose each document once.")});

function storageKey(document:InboxIntakeDocument):string|null {
  return normalizeInboxStorageName(document.objectStorageKey)??normalizeInboxStorageName(document.storagePath);
}
function validateDocuments(documents:InboxIntakeDocument[],ids:string[],labId:string) {
  if(documents.length!==ids.length || ids.some(id=>!documents.some(d=>d.id===id&&d.labOrganizationId===labId))) throw new HttpError(404,"One or more documents are unavailable in this lab.");
  if(documents.some(d=>!storageKey(d))) throw new HttpError(409,"One or more entries has no usable file. Nothing was linked.");
}
async function completeSelection(deps:InboxIntakeDependencies,labId:string,ids:string[]) {
  const groups=await deps.groups(labId,ids);
  if(groups.some(group=>group.labOrganizationId!==labId) || groups.length>1) throw new HttpError(409,"Choose documents from one website submission at a time.");
  const group=groups[0];
  if(group && ids.some(id=>!group.documentIds.includes(id))) throw new HttpError(409,"Do not mix a website prescription with unrelated documents.");
  if(!group && ids.length!==1) throw new HttpError(409,"Choose one existing document, or one complete website submission.");
  const expanded=group?group.documentIds:ids;
  if(expanded.length<1 || expanded.length>13 || new Set(expanded).size!==expanded.length || (group&&!expanded.includes(group.prescriptionDocumentId))) throw new HttpError(409,"This document group is incomplete. Nothing was linked.");
  return {ids:expanded,prescriptionDocumentId:group?.prescriptionDocumentId??null};
}

/** ID-only transfer. Originals keep their private keys; no file bytes, URLs,
 * case creation or invoice creation are accepted by these endpoints. */
export function createLabInboxIntakeRouter(dependencies?:InboxIntakeDependencies) {
  const router=Router();router.use(requireAuth);
  const resolve=async()=>dependencies??(await import("../lib/lab-inbox-intake-persistence")).labInboxIntakePersistence;
  router.post("/prepare-intake",async(req,res,next)=>{
    try {
      const parsed=requestSchema.safeParse(req.body);if(!parsed.success)throw new HttpError(400,"Choose one to thirteen distinct document IDs and a lab.");
      const {labOrganizationId,documentIds}=parsed.data;const deps=await resolve();
      await deps.authorize((req as any).auth.userId,labOrganizationId);
      const selection=await completeSelection(deps,labOrganizationId,documentIds);
      const documents=await deps.documents(labOrganizationId,selection.ids);validateDocuments(documents,selection.ids,labOrganizationId);
      if(documents.some(d=>d.assignedAt))throw new HttpError(409,"These documents have already been assigned. Open their existing case instead.");
      const ordered=selection.ids.map(id=>documents.find(d=>d.id===id)!);
      const prescriptionDocumentId=selection.prescriptionDocumentId??ordered.find(d=>d.mimeType==="application/pdf"||["image/jpeg","image/png","image/webp"].includes(d.mimeType??""))?.id??null;
      return ok(res,{labOrganizationId,prescriptionDocumentId,documents:ordered.map(d=>({id:d.id,fileName:d.originalFilename??"Document",mimeType:d.mimeType??"application/octet-stream",sizeBytes:d.sizeBytes??0}))});
    }catch(error){return next(error);}
  });
  router.post("/assign-batch",async(req,res,next)=>{
    try {
      const parsed=requestSchema.extend({caseId:id}).safeParse(req.body);if(!parsed.success)throw new HttpError(400,"A case, lab and distinct document IDs are required.");
      const {labOrganizationId,documentIds,caseId}=parsed.data;const userId=(req as any).auth.userId as string;const deps=await resolve();
      await deps.authorize(userId,labOrganizationId);
      const selection=await completeSelection(deps,labOrganizationId,documentIds);
      const attachmentIds=await deps.transaction(async tx=>{
        // Lock ordering is identical for every request: case, then inbox IDs.
        // In particular, do not trust a case tenant read before this lock.
        const target=await tx.lockCase(caseId);if(!target)throw new HttpError(404,"Case not found.");
        if(target.labOrganizationId!==labOrganizationId)throw new HttpError(403,"That case belongs to a different lab.");
        const documents=await tx.lockDocuments(labOrganizationId,[...selection.ids].sort());validateDocuments(documents,selection.ids,labOrganizationId);
        const result:string[]=[];
        for(const sourceId of selection.ids) {
          const document=documents.find(d=>d.id===sourceId)!;const key=storageKey(document)!;
          const existing=await tx.attachment(caseId,document.id);
          if(document.assignedAt) {
            if(document.assignedToCaseId!==caseId || !existing || existing.storageKey!==key)throw new HttpError(409,"A document is already assigned elsewhere or its existing attachment needs review.");
            result.push(existing.id);continue;
          }
          if(existing)throw new HttpError(409,"The existing attachment must be reviewed before linking again.");
          const attachmentId=await tx.insertAttachment({caseId,uploadedByUserId:userId,uploadedByOrganizationId:labOrganizationId,fileName:document.originalFilename??"Document",storageKey:key,fileType:document.mimeType??"application/octet-stream",submissionId:`inbox:${document.id}`,visibility:"internal_lab_only",note:document.note});
          await tx.assign(document.id,caseId,userId);
          await tx.event({caseId,actorUserId:userId,actorOrganizationId:labOrganizationId,attachmentId,fileName:document.originalFilename??"Document",fileType:document.mimeType??"application/octet-stream"});
          result.push(attachmentId);
        }
        return result;
      });
      return ok(res,{caseId,documentIds:selection.ids,attachmentIds});
    }catch(error){return next(error);}
  });
  return router;
}
