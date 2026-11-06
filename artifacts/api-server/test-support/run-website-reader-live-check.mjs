/** Explicit, staging-only synthetic reader verification. Never a release gate. */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startVitest } from "vitest/node";

const stagingProjectId="e4dde0b0-3879-45ed-b384-577c723abe98";
if(process.env.REPL_ID!==stagingProjectId || process.env.SDR_RUN_LIVE_READER_CHECK!=="1")throw new Error("This manual check is restricted to the approved SDR staging project.");
if(!process.env.AI_INTEGRATIONS_OPENAI_API_KEY)throw new Error("The staging AI credential is not configured.");

// The real AI credential stays in its configured environment. No database,
// actual lab identity, case, invoice, attachment or notification is available.
process.env.NODE_ENV="test";
process.env.DATABASE_URL="postgresql://synthetic:synthetic@127.0.0.1:1/no_database";
delete process.env.PROD_DATABASE_URL;
process.env.LABTRAX_ENABLE_DEMO_SEEDS="false";
process.env.LOG_LEVEL="silent";
process.env.JWT_SECRET=randomBytes(32).toString("hex");
process.env.SDR_WEBSITE_READER_ENABLED="true";
process.env.SDR_WEBSITE_READER_TOKEN=randomBytes(32).toString("hex");
process.env.SDR_WEBSITE_LAB_ORG_ID="synthetic-sdr-reader-only";
const root=fileURLToPath(new URL("..",import.meta.url));
const file="test-support/website-reader-live-check.test.ts";
const context=await startVitest("test",[file],{root,config:fileURLToPath(new URL("../vitest.config.ts",import.meta.url)),include:[file],watch:false});
if(!context){process.exitCode=1;}else{
  const files=context.state.getFiles();
  const failed=files.length!==1 || files.some(file=>file.result?.state!=="pass") || context.state.getUnhandledErrors().length>0;
  await context.close();
  if(failed)process.exitCode=1;
}
