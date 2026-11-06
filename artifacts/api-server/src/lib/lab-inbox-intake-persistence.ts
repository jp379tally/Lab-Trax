import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, caseAttachments, caseEvents, cases, labInboxFiles, organizations, websiteIntakeSubmissions } from "@workspace/db";
import { HttpError } from "./http";
import { notDeleted } from "./soft-delete";
import { requireAnyRole } from "./rbac";
import { getEntitlement } from "./entitlement";
import type { InboxIntakeDependencies } from "../routes/lab-inbox-intake";

export const labInboxIntakePersistence:InboxIntakeDependencies={
  async authorize(userId,labId) {
    const lab=await db.query.organizations.findFirst({where:and(eq(organizations.id,labId),eq(organizations.type,"lab"),notDeleted(organizations)),columns:{id:true}});
    if(!lab)throw new HttpError(404,"Lab not found.");
    await requireAnyRole(userId,labId,["owner","admin","user","billing"]);
    const entitlement=await getEntitlement({subjectType:"lab_org",subjectId:labId});
    if(entitlement.status==="free" || entitlement.status==="onboarding_pending" || (entitlement.accessLevel==="read_only"&&!entitlement.hasActiveWaiver))throw new HttpError(403,"This lab is read-only.");
  },
  async documents(labId,ids) {
    return db.select().from(labInboxFiles).where(and(eq(labInboxFiles.labOrganizationId,labId),inArray(labInboxFiles.id,ids)));
  },
  async groups(labId,ids) {
    const rows=await db.select().from(websiteIntakeSubmissions).where(and(eq(websiteIntakeSubmissions.labOrganizationId,labId),sql`${websiteIntakeSubmissions.documentIds} && ARRAY[${sql.join(ids.map(id=>sql`${id}`),sql`, `)}]::text[]`));
    return rows.map(row=>({id:row.id,labOrganizationId:row.labOrganizationId,documentIds:row.documentIds,prescriptionDocumentId:row.receipt.prescriptionDocumentId}));
  },
  async transaction(work) {
    return db.transaction(async tx=>work({
      async lockCase(id){const [row]=await tx.select({id:cases.id,labOrganizationId:cases.labOrganizationId}).from(cases).where(and(eq(cases.id,id),notDeleted(cases))).for("update");return row??null;},
      async lockDocuments(labId,ids){return tx.select().from(labInboxFiles).where(and(eq(labInboxFiles.labOrganizationId,labId),inArray(labInboxFiles.id,ids))).orderBy(asc(labInboxFiles.id)).for("update");},
      async attachment(caseId,sourceId){const row=await tx.query.caseAttachments.findFirst({where:and(eq(caseAttachments.caseId,caseId),eq(caseAttachments.submissionId,`inbox:${sourceId}`),isNull(caseAttachments.deletedAt)),columns:{id:true,storageKey:true}});return row??null;},
      async insertAttachment(row){const [saved]=await tx.insert(caseAttachments).values(row).returning({id:caseAttachments.id});if(!saved)throw new Error("Attachment identifier unavailable.");return saved.id;},
      async assign(id,caseId,userId){const [saved]=await tx.update(labInboxFiles).set({assignedAt:new Date(),assignedToCaseId:caseId,assignedByUserId:userId,updatedAt:new Date()}).where(and(eq(labInboxFiles.id,id),isNull(labInboxFiles.assignedAt))).returning({id:labInboxFiles.id});if(!saved)throw new HttpError(409,"This document was assigned by another request.");},
      async event(row){await tx.insert(caseEvents).values({caseId:row.caseId,eventType:"file_assigned_from_inbox",actorUserId:row.actorUserId,actorOrganizationId:row.actorOrganizationId,metadataJson:{attachmentId:row.attachmentId,fileName:row.fileName,fileType:row.fileType,description:"Linked an existing unassigned document to this case."}});},
    }));
  },
};
