import { Router } from "express";
import multer from "multer";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fingerprintSubmission, inspectWebsiteFile, parseWebsiteWorkOrder, WEBSITE_FILE_LIMIT, WEBSITE_TOTAL_LIMIT, WebsiteIntakeError, type WebsiteIntakeReceipt, type WebsiteUpload } from "../lib/website-intake-contract";

export interface WebsiteIntakeConfig {enabled:boolean;token:string;labOrganizationId:string;uploaderId:string;}
export interface WebsiteInboxRow {labOrganizationId:string;uploadedByUserId:string;originalFilename:string;mimeType:string;sizeBytes:number;storagePath:string;objectStorageKey:string;note:string;}
export interface WebsiteIntakeTransaction {
  find():Promise<{fingerprint:string;receipt:WebsiteIntakeReceipt}|null>;
  insert(row:WebsiteInboxRow):Promise<string>;
  save(fingerprint:string,receipt:WebsiteIntakeReceipt):Promise<void>;
}
export interface WebsiteIntakeDependencies {
  config():WebsiteIntakeConfig;
  ready():Promise<void>;
  scan(file:WebsiteUpload,signal:AbortSignal):Promise<void>;
  store(file:WebsiteUpload,key:string,signal:AbortSignal):Promise<void>;
  transaction<T>(labId:string,submissionId:string,work:(tx:WebsiteIntakeTransaction)=>Promise<T>):Promise<T>;
}
export function websiteIntakeConfig(): WebsiteIntakeConfig {
  return {enabled:process.env.SDR_WEBSITE_INTAKE_ENABLED==="true",token:process.env.SDR_WEBSITE_INTAKE_TOKEN??"",labOrganizationId:process.env.SDR_WEBSITE_LAB_ORG_ID??"",uploaderId:process.env.SDR_WEBSITE_INTAKE_USER_ID??""};
}
const productionDependencies:WebsiteIntakeDependencies={
  config:websiteIntakeConfig,
  ready:async()=>{await (await import("../lib/website-intake-persistence")).websiteIntakePersistence.ready();},
  scan:async(file,signal)=>{await (await import("../lib/website-intake-persistence")).websiteIntakePersistence.scan(file,signal);},
  store:async(file,key,signal)=>{await (await import("../lib/website-intake-persistence")).websiteIntakePersistence.store(file,key,signal);},
  transaction:async(lab,ref,work)=>(await import("../lib/website-intake-persistence")).websiteIntakePersistence.transaction(lab,ref,work),
};
function bearerMatches(given:string|undefined,expected:string) {
  return timingSafeEqual(createHash("sha256").update(given??"").digest(),createHash("sha256").update(`Bearer ${expected}`).digest());
}

export function createWebsiteIntakeRouter(deps:WebsiteIntakeDependencies=productionDependencies) {
  const router=Router();let active=0;
  router.post("/public-intake",async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");res.setHeader("X-Content-Type-Options","nosniff");
    const config=deps.config();let scratch:string|undefined;let admitted=false;
    let responseStatus=503;let responseBody:WebsiteIntakeReceipt|{ok:false;error:string}={ok:false,error:"Delivery could not be confirmed."};
    const controller=new AbortController();
    const abort=()=>controller.abort();const disconnected=()=>{if(!res.writableEnded)abort();};
    const deadline=setTimeout(()=>{controller.abort();req.destroy();},240_000);deadline.unref();
    req.once("aborted",abort);res.once("close",disconnected);
    try {
      if(!config.enabled || config.token.length<32 || !config.labOrganizationId || !config.uploaderId) throw new WebsiteIntakeError(503,"Website delivery is not enabled.");
      if(!bearerMatches(req.headers.authorization,config.token)) throw new WebsiteIntakeError(401,"Website authorization is invalid.");
      if(!req.secure) throw new WebsiteIntakeError(403,"HTTPS is required.");
      if(active>=1) {res.setHeader("Retry-After","5");throw new WebsiteIntakeError(429,"Website intake is busy. Retry shortly with the same reference.");}
      active++;admitted=true;
      await deps.ready();
      scratch=await mkdtemp(path.join(tmpdir(),"labtrax-sdr-intake-"));const directory=scratch;let total=0;
      const storage:multer.StorageEngine={
        _handleFile(_request,file,done){
          const filename=randomUUID();const target=path.join(directory,filename);let size=0;
          const bound=new Transform({transform(chunk:Buffer,_encoding,next){size+=chunk.length;total+=chunk.length;if(total>WEBSITE_TOTAL_LIMIT)next(new WebsiteIntakeError(413,"The total upload is too large."));else next(null,chunk);}});
          pipeline(file.stream,bound,createWriteStream(target,{flags:"wx",mode:0o600}),{signal:controller.signal}).then(()=>done(null,{path:target,destination:directory,filename,size}),error=>done(error));
        },
        _removeFile(_request,file,done){unlink(file.path).then(()=>done(null),error=>done(error.code==="ENOENT"?null:error));},
      };
      const receive=multer({storage,limits:{fileSize:WEBSITE_FILE_LIMIT,files:13,fields:3,fieldSize:768*1024,parts:17}}).any();
      await new Promise<void>((resolve,reject)=>receive(req,res,error=>error?reject(error):resolve()));
      if(req.body?.labOrganizationId!==config.labOrganizationId) throw new WebsiteIntakeError(403,"The receiving lab does not match.");
      if(req.body?.source!=="sdrdl.com") throw new WebsiteIntakeError(400,"The website source is invalid.");
      const raw=req.body?.payload;const order=await parseWebsiteWorkOrder(raw);
      if(req.get("Idempotency-Key")!==order.submissionId) throw new WebsiteIntakeError(400,"The submission reference does not match.");
      const uploaded=Array.isArray(req.files)?req.files:[];
      const prescriptions=uploaded.filter(f=>f.fieldname==="prescription");
      const supporting=uploaded.filter(f=>/^files\[(?:[0-9]|1[01])\]$/.test(f.fieldname)).sort((a,b)=>Number(a.fieldname.slice(6,-1))-Number(b.fieldname.slice(6,-1)));
      if(prescriptions.length!==1 || uploaded.length!==supporting.length+1 || supporting.length>12 || supporting.some((f,i)=>f.fieldname!==`files[${i}]`)) throw new WebsiteIntakeError(400,"Include one signed prescription PDF and up to twelve separate originals.");
      const files:WebsiteUpload[]=[];
      for(const [index,file] of [prescriptions[0]!,...supporting].entries()) files.push(await inspectWebsiteFile(file,index===0,controller.signal));
      const fingerprint=fingerprintSubmission(raw,files);
      const priorReceipt=async(tx:WebsiteIntakeTransaction)=>{
        const existing=await tx.find();
        if(!existing)return null;
        if(existing.fingerprint!==fingerprint)throw new WebsiteIntakeError(409,"This reference belongs to different prescription data or files.");
        return {receipt:existing.receipt,replayed:true};
      };
      let result=await deps.transaction(config.labOrganizationId,order.submissionId,priorReceipt);
      if(!result){
        // Scanning and cloud transfer must not occupy a database transaction.
        // A second short, locked transaction rechecks the receipt before writes.
        for(const file of files)await deps.scan(file,controller.signal);
        const keys=files.map(file=>`${randomUUID()}${path.extname(file.originalFilename).toLowerCase()}`);
        for(const [i,file] of files.entries())await deps.store(file,keys[i]!,controller.signal);
        if(controller.signal.aborted)throw new WebsiteIntakeError(503,"Delivery was interrupted. Retry using the same reference.");
        await deps.ready();
        result=await deps.transaction(config.labOrganizationId,order.submissionId,async tx=>{
          const prior=await priorReceipt(tx);if(prior)return prior;
          const ids:string[]=[];
          for(const [i,file] of files.entries())ids.push(await tx.insert({labOrganizationId:config.labOrganizationId,uploadedByUserId:config.uploaderId,originalFilename:file.originalFilename,mimeType:file.mimeType,sizeBytes:file.sizeBytes,storagePath:keys[i]!,objectStorageKey:keys[i]!,note:`SDR website ${i===0?"signed prescription":"supporting original"}. Reference: ${order.submissionId}`}));
          const receipt:WebsiteIntakeReceipt={ok:true,submissionId:order.submissionId,prescriptionDocumentId:ids[0]!,supportingDocumentIds:ids.slice(1)};
          await tx.save(fingerprint,receipt);return {receipt,replayed:false};
        });
      }
      responseStatus=result.replayed?200:201;responseBody=result.receipt;
    }catch(error){
      if(!res.headersSent&&!res.destroyed){
        const status=error instanceof WebsiteIntakeError?error.status:error instanceof multer.MulterError?(error.code==="LIMIT_UNEXPECTED_FILE"?400:413):503;
        responseStatus=status;responseBody={ok:false,error:error instanceof WebsiteIntakeError?error.message:status===413?"The upload exceeds the supported limits.":"Delivery could not be confirmed. Keep the same reference and retry or contact SDR."};
      }
    }finally{
      clearTimeout(deadline);req.off("aborted",abort);res.off("close",disconnected);
      if(scratch)await rm(scratch,{recursive:true,force:true}).catch(()=>{});
      if(admitted)active--;
    }
    if(!res.headersSent&&!res.destroyed)res.status(responseStatus).json(responseBody);
  });
  return router;
}
