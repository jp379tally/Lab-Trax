/** Manual opt-in only: outside src/ so normal tests cannot incur AI charges.
 * Run through run-website-reader-live-check.mjs in the named staging project.
 * This calls the actual website entrance, real shared reader and real OpenAI
 * service. Only startup schedulers are stubbed; no user session is fabricated.
 */
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../src/lib/backup.js",()=>({restartScheduledBackupJob:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../src/lib/billing-jobs.js",()=>({startBillingJobs:vi.fn()}));
vi.mock("../src/lib/statements.js",()=>({startStatementScheduler:vi.fn()}));
vi.mock("../src/lib/case-media.js",()=>({startDailyOrphanedMediaCleanup:vi.fn(),caseMediaDir:path.join(os.tmpdir(),"sdr-synthetic-reader-check"),extractMediaFileName:()=>null}));

// Trace only provider model/status/error-code metadata. The subclass forwards
// every request to the real SDK, with no response substitution or key output.
vi.mock("openai",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("openai")>();
  class TracedOpenAI extends actual.default {
    constructor(options:ConstructorParameters<typeof actual.default>[0]){
      super(options);
      const create=this.chat.completions.create.bind(this.chat.completions);
      this.chat.completions.create=((body:any,options:any)=>{
        console.log(JSON.stringify({liveProviderRequest:true,model:body.model}));
        return create(body,options).catch((error:any)=>{
          console.log(JSON.stringify({liveProviderFailure:true,status:Number.isInteger(error?.status)?error.status:null,code:typeof error?.code==="string"&&/^[a-z0-9_]{1,64}$/i.test(error.code)?error.code:"request_failed"}));
          throw error;
        });
      }) as typeof this.chat.completions.create;
    }
  }
  return {...actual,default:TracedOpenAI};
});

describe("manual real SDR website prescription reader check",()=>{
  it("extracts editable contact, patient and tooth/material/shade fields from a synthetic prescription",async()=>{
    if(process.env.REPL_ID!=="e4dde0b0-3879-45ed-b384-577c723abe98" || process.env.SDR_RUN_LIVE_READER_CHECK!=="1")throw new Error("Run only through the approved staging diagnostic.");
    const lines=["STAGING TEST ONLY - NOT A PATIENT RECORD","SDR DENTAL LAB - SYNTHETIC PRESCRIPTION","Doctor: Dr. Tess Synthetic","License number: TEST-DN-1234","Practice: Synthetic Test Dental","Address: 123 Test Lane, Tallahassee, FL 32301","Phone: (850) 555-0100","Email: tess@example.invalid","Patient: Sample Patient","Case type: Crown and Bridge","Restoration: Crown","Tooth number (Universal): 4","Material: Zirconia","Shade: A2","Instructions: Synthetic verification only. Do not create a case."];
    const svg=`<svg width="1200" height="1050" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${lines.map((line,index)=>`<text x="55" y="${65+index*64}" font-family="sans-serif" font-size="${index<2?28:30}" fill="black">${line}</text>`).join("")}</svg>`;
    const bytes=await sharp(Buffer.from(svg)).png().toBuffer();
    expect(bytes.length).toBeGreaterThan(3750);
    const {default:app}=await import("../src/app.js");
    await vi.waitFor(async()=>expect((await request(app).get("/api/__synthetic_reader_readiness__")).status).toBe(404),{timeout:30_000,interval:50});
    const result=await request(app).post("/api/website-intake/analyze-prescription")
      .set("Authorization",`Bearer ${process.env.SDR_WEBSITE_READER_TOKEN}`)
      .set("X-SDR-Lab-Organization",process.env.SDR_WEBSITE_LAB_ORG_ID!)
      .send({imageBase64:`data:image/png;base64,${bytes.toString("base64")}`});
    console.log(JSON.stringify({liveReaderHttpStatus:result.status,success:result.body?.success===true}));
    expect(result.status).toBe(200);expect(result.body.success).toBe(true);
    const data=result.body.data;
    const summary=Object.fromEntries(["doctorName","doctorLicenseNumber","practiceAddress","practicePhone","practiceEmail","patientName","caseType","restorationType","toothIndices","material","shade"].map(key=>[key,data[key]??null]));
    console.log(JSON.stringify({syntheticOnly:true,liveReaderExtracted:summary}));
    expect(String(data.doctorName).toLowerCase()).toContain("tess synthetic");
    expect(String(data.doctorLicenseNumber).replace(/[^a-z0-9]/gi,"").toUpperCase()).toBe("TESTDN1234");
    expect(String(data.practiceAddress).toLowerCase()).toContain("123 test lane");
    expect(String(data.practicePhone).replace(/\D/g,"")).toBe("8505550100");
    expect(String(data.practiceEmail).toLowerCase()).toBe("tess@example.invalid");
    expect(String(data.patientName).toLowerCase()).toBe("sample patient");
    expect(String(data.caseType).toLowerCase()).toContain("crown");
    expect(String(data.restorationType).toLowerCase()).toContain("crown");
    expect(String(data.toothIndices)).toMatch(/\b4\b/);
    expect(String(data.material).toLowerCase()).toContain("zirconia");
    expect(String(data.shade).toUpperCase()).toBe("A2");
    expect(data).not.toHaveProperty("signature");
  },120_000);
});
