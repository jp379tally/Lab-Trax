import { describe, expect, it, vi } from "vitest";
import express, { json } from "express";
import request from "supertest";

const { insert } = vi.hoisted(() => ({ insert: vi.fn() }));

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return { ...original, db: { insert } };
});
vi.mock("../middlewares/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireVerifiedAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import providerRouter from "./provider.js";

describe("retired provider self-reported payment route", () => {
  it("rejects every payment method before writing payments or notifications", async () => {
    const app = express();
    app.use(json());
    app.use((req, _res, next) => {
      (req as unknown as { auth: { userId: string } }).auth = {
        userId: "provider_user",
      };
      next();
    });
    app.use("/provider", providerRouter);

    for (const paymentMethod of ["card", "ach", "check", "cash", "other"]) {
      const response = await request(app)
        .post("/provider/pay")
        .send({ invoiceId: "inv_1", amount: 50, paymentMethod });
      expect(response.status).toBe(410);
    }
    expect(insert).not.toHaveBeenCalled();
  });
});