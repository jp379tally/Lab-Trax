import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  MONITORED_SERVICE_ROOTS,
  serviceRootHealth,
} from "./service-root-health";

function createTestApp() {
  const app = express();
  app.get(MONITORED_SERVICE_ROOTS, serviceRootHealth);
  return app;
}

describe("service route-root health responses", () => {
  it.each(MONITORED_SERVICE_ROOTS)("returns 200 for GET %s", async (path) => {
    const response = await request(createTestApp()).get(path);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ status: "ok" });
  });

  it.each(MONITORED_SERVICE_ROOTS)(
    "does not mask a missing nested route below %s",
    async (path) => {
      const response = await request(createTestApp()).get(`${path}/missing`);

      expect(response.status).toBe(404);
    },
  );

  it.each(MONITORED_SERVICE_ROOTS)(
    "does not change POST behavior for %s",
    async (path) => {
      const response = await request(createTestApp()).post(path);

      expect(response.status).toBe(404);
    },
  );
});