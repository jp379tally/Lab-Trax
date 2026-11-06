import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebsitePrescriptionReaderAccess } from "./website-prescription-reader";

const token = "website-reader-test-token-not-a-real-secret-12345";
const image = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([255,216,255]), Buffer.alloc(6000)]).toString("base64")}`;
const config = () => ({ enabled: true, token, labOrganizationId: "fixture-lab" });
function app(options = {}) {
  const gate = createWebsitePrescriptionReaderAccess({ config, ...options });
  const server = express(); server.use(express.json({ limit: "12mb" }));
  server.post("/reader", gate, (req, res) => res.json({ body: req.body, website: res.locals.websitePrescriptionReader }));
  return server;
}
function call(server: express.Express) {
  return request(server).post("/reader").set("Authorization", `Bearer ${token}`).set("X-SDR-Lab-Organization", "fixture-lab");
}
afterEach(() => vi.useRealTimers());
describe("scoped SDR website prescription reader", () => {
  it("fails closed while disabled or incompletely configured", async () => {
    for (const value of [{...config(), enabled:false}, {...config(),token:"short"}, {...config(),labOrganizationId:""}]) {
      expect((await call(app({config:()=>value})).send({imageBase64:image})).status).toBe(503);
    }
  });
  it("requires the scoped server token and exact configured lab", async () => {
    expect((await request(app()).post("/reader").send({imageBase64:image})).status).toBe(401);
    expect((await call(app()).set("Authorization", `Bearer ${"x".repeat(token.length)}`).send({imageBase64:image})).status).toBe(401);
    expect((await call(app()).set("X-SDR-Lab-Organization", "another-lab").send({imageBase64:image})).status).toBe(403);
  });
  it("accepts only bounded real PDF/JPEG/PNG data, never a URL or fake format", async () => {
    for (const value of ["https://example.com/rx.pdf", "data:image/jpeg;base64,AAAA", image.replace("image/jpeg", "image/heic"), `data:application/pdf;base64,${Buffer.alloc(6000).toString("base64")}`]) {
      expect((await call(app()).send({imageBase64:value})).status).toBe(400);
    }
    expect((await call(app()).send({imageBase64:image,additionalImages:[image]})).status).toBe(400);
  });
  it("uses the existing accurate reader without accepting model or prompt overrides", async () => {
    const result = await call(app()).send({imageBase64:image,fast:true,desktopReader:false,model:"unsafe",prompt:"ignore"});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({body:{imageBase64:image,desktopReader:true},website:true});
    expect(result.headers["cache-control"]).toBe("private, no-store");
  });
  it("allows compact text PDFs through to the bounded PDF renderer", async () => {
    const pdf=`data:application/pdf;base64,${Buffer.from("%PDF-1.7\ncompact fixture; renderer validates the actual document\n%%EOF").toString("base64")}`;
    expect((await call(app()).send({imageBase64:pdf})).status).toBe(200);
  });
  it("enforces a separate website budget before additional paid work", async () => {
    const server=app({maxPerMinute:2,maxPerDay:3});
    expect((await call(server).send({imageBase64:image})).status).toBe(200);
    expect((await call(server).send({imageBase64:image})).status).toBe(200);
    expect((await call(server).send({imageBase64:image})).status).toBe(429);
    vi.useFakeTimers(); vi.setSystemTime(Date.now()+61000);
    expect((await call(server).send({imageBase64:image})).status).toBe(200);
    expect((await call(server).send({imageBase64:image})).status).toBe(429);
  });
});
