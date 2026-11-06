import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

type Configuration = { enabled: boolean; token: string; labOrganizationId: string };

/** A service-only entrance to the SAME reader used by signed-in LabTrax clients.
 * No user session is fabricated. This credential cannot read records, sign a
 * prescription, upload persistent media, create a case, or call other APIs.
 * The WordPress server separately enforces same-origin sessions and a durable
 * website-wide daily budget. This additional process-local budget limits bursts.
 */
export function createWebsitePrescriptionReaderAccess(options: {
  config?: () => Configuration;
  maxPerMinute?: number;
  maxPerDay?: number;
} = {}): RequestHandler {
  const configuration = options.config ?? (() => ({
    enabled: process.env.SDR_WEBSITE_READER_ENABLED === "true",
    token: process.env.SDR_WEBSITE_READER_TOKEN ?? "",
    labOrganizationId: process.env.SDR_WEBSITE_LAB_ORG_ID ?? "",
  }));
  let minute = { count: 0, expires: 0 }, day = { count: 0, expires: 0 };
  return (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    const config=configuration();
    if(!config.enabled||config.token.length<32||!config.labOrganizationId) {
      res.status(503).json({success:false,error:"The website prescription reader is not enabled."});return;
    }
    const provided = req.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1] ?? "";
    const expected=Buffer.from(config.token), actual=Buffer.from(provided);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) {
      res.status(401).json({success:false,error:"Website reader authentication required."});return;
    }
    if(req.get("X-SDR-Lab-Organization")!==config.labOrganizationId) {
      res.status(403).json({success:false,error:"This website is not configured for this lab."});return;
    }
    const value=req.body?.imageBase64;
    const match=typeof value==="string"&&value.length<=Math.ceil(8*1024*1024/3)*4+100
      ? value.match(/^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/) : null;
    const bytes=match?Buffer.from(match[2],"base64"):null;
    const valid=bytes&&bytes.length>=(match![1]==="application/pdf"?20:3750)&&bytes.length<=8*1024*1024&&(
      (match![1]==="application/pdf"&&bytes.subarray(0,5).toString()==="%PDF-")||
      (match![1]==="image/jpeg"&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||
      (match![1]==="image/png"&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    );
    if(!valid||(req.body.additionalImages&&(!Array.isArray(req.body.additionalImages)||req.body.additionalImages.length))) {
      res.status(400).json({success:false,error:"Choose one readable PDF, JPG, or PNG prescription up to 8 MB."});return;
    }
    const now=Date.now();
    if(now>=minute.expires) minute={count:0,expires:now+60_000};
    if(now>=day.expires) day={count:0,expires:now+86_400_000};
    if(minute.count>=(options.maxPerMinute??6)||day.count>=(options.maxPerDay??100)) {
      res.setHeader("Retry-After",String(Math.max(1,Math.ceil(((day.count>=(options.maxPerDay??100)?day:minute).expires-now)/1000))));
      res.status(429).json({success:false,error:"The website AI reader has reached its temporary limit. Continue manually or try later."});return;
    }
    minute.count++;day.count++;
    // Only file bytes and the accurate-reader flag reach the shared handler.
    // Never accept a visitor's model, system prompt, storage URL or account id.
    req.body={imageBase64:value,desktopReader:true};
    res.locals.websitePrescriptionReader=true;
    next();
  };
}
