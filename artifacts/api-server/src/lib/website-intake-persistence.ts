import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { db, labInboxFiles, organizations, users, websiteIntakeSubmissions } from "@workspace/db";
import { requireMembership } from "./rbac";
import { getEntitlement } from "./entitlement";
import { notDeleted } from "./soft-delete";
import { caseMediaObjectStorageAvailable, writeCaseMediaPathToObjectStorage } from "./case-media-object-storage";
import { WebsiteIntakeError } from "./website-intake-contract";
import { websiteIntakeConfig, type WebsiteIntakeDependencies } from "../routes/website-intake";

const run=promisify(execFile);
export function assertWebsitePrivateStorage() {
  const root=(process.env.PRIVATE_OBJECT_DIR??"").replace(/^\/+|\/+$/g,"");
  if(!caseMediaObjectStorageAvailable() || !/^[^/]+\/[^/]+/.test(root)) throw new WebsiteIntakeError(503,"Private durable storage is not configured.");
  for(const entry of (process.env.PUBLIC_OBJECT_SEARCH_PATHS??"").split(",")) {
    const publicRoot=entry.trim().replace(/^\/+|\/+$/g,"");
    if(publicRoot && (root===publicRoot || root.startsWith(publicRoot+"/") || publicRoot.startsWith(root+"/"))) throw new WebsiteIntakeError(503,"Website files cannot use public storage.");
  }
}
export const websiteIntakePersistence:WebsiteIntakeDependencies={
  config:websiteIntakeConfig,
  async ready(){
    const config=websiteIntakeConfig();assertWebsitePrivateStorage();
    const scanner=process.env.SDR_WEBSITE_SCANNER_PATH??"";
    if(!path.isAbsolute(scanner) || !["clamscan","clamdscan"].includes(path.basename(scanner))) throw new WebsiteIntakeError(503,"Upload scanning is not configured.");
    await access(scanner,constants.X_OK);
    const [lab,actor]=await Promise.all([
      db.query.organizations.findFirst({where:and(eq(organizations.id,config.labOrganizationId),eq(organizations.type,"lab"),notDeleted(organizations))}),
      db.query.users.findFirst({where:and(eq(users.id,config.uploaderId),eq(users.isActive,true),notDeleted(users))}),
    ]);
    if(!lab || !actor) throw new WebsiteIntakeError(503,"The receiving lab or upload account is unavailable.");
    const member=await requireMembership(config.uploaderId,config.labOrganizationId);
    if(!["owner","admin","user","billing"].includes(member.role)) throw new WebsiteIntakeError(403,"The upload account cannot add documents.");
    // A service request has no browser entitlement context. Check explicitly.
    const entitlement=await getEntitlement({subjectType:"lab_org",subjectId:config.labOrganizationId});
    if(entitlement.status==="free" || entitlement.status==="onboarding_pending" || (entitlement.accessLevel==="read_only"&&!entitlement.hasActiveWaiver)) throw new WebsiteIntakeError(403,"The receiving lab is read-only.");
  },
  async scan(file,signal){
    const scanner=process.env.SDR_WEBSITE_SCANNER_PATH!;
    try {
      await run(scanner,[...(path.basename(scanner)==="clamdscan"?["--fdpass"]:[]),"--no-summary","--infected","--",file.path],{timeout:45_000,maxBuffer:64*1024,signal});
    }catch(error){
      if((error as {code?:unknown}).code===1)throw new WebsiteIntakeError(422,"A file was rejected by upload scanning.");
      throw new WebsiteIntakeError(503,"Upload scanning could not be completed. Nothing was accepted.");
    }
  },
  async store(file,key,signal){
    assertWebsitePrivateStorage();
    if(!await writeCaseMediaPathToObjectStorage(key,file.path,file.mimeType,signal)) throw new WebsiteIntakeError(503,"Private file storage could not be confirmed.");
  },
  async transaction(labId,submissionId,work){
    return db.transaction(async tx=>{
      const lock=await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`sdr-website:${labId}:${submissionId}`},0)) as acquired`);
      if(!(lock as any).rows?.[0]?.acquired) throw new WebsiteIntakeError(409,"This reference is being processed. Retry shortly with the same reference.");
      return work({
        async find(){
          const row=await tx.query.websiteIntakeSubmissions.findFirst({where:and(eq(websiteIntakeSubmissions.labOrganizationId,labId),eq(websiteIntakeSubmissions.submissionId,submissionId))});
          return row?{fingerprint:row.fingerprint,receipt:row.receipt}:null;
        },
        async insert(row){const [saved]=await tx.insert(labInboxFiles).values(row).returning({id:labInboxFiles.id});if(!saved)throw new Error("Inbox insert did not return an identifier.");return saved.id;},
        async save(fingerprint,receipt){await tx.insert(websiteIntakeSubmissions).values({labOrganizationId:labId,submissionId,fingerprint,documentIds:[receipt.prescriptionDocumentId,...receipt.supportingDocumentIds],receipt});},
      });
    });
  },
};
