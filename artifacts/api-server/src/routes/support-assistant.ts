import type { IRouter, Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { getAiClient } from "../lib/ai-openai-client";
import { createRateLimit, createUserRateLimit } from "../lib/rate-limit";
import { writeAuditLog } from "../lib/audit";
import { HttpError } from "../lib/http";
import { answerSupport, SupportError, validateSupportMessage } from "../lib/support-assistant.mjs";
import { lookupSupportData, resolveSupportScope } from "../lib/support-assistant-data";
import { supportPage, supportWidget } from "../lib/support-assistant-views.mjs";

// Explicit enablement keeps the public endpoint dark until deployment is configured.
function enabled(_req: Request, res: Response, next: NextFunction) {
  if (process.env.SUPPORT_ASSISTANT_ENABLED !== "true") {
    res.status(404).json({ error: "Support assistant is not enabled." });
    return;
  }
  next();
}

export function registerSupportAssistantRoutes(router: IRouter): void {
  router.get("/support-assistant/config", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, data: {
      enabled: process.env.SUPPORT_ASSISTANT_ENABLED === "true",
    } });
  });
  const publicLimit = createRateLimit({ windowMs: 60_000, max: 6 });
  const accountLimit = createUserRateLimit({ windowMs: 60_000, max: 10 });
  router.get("/support-assistant/widget.js", enabled, (_req, res) => {
    res.type("application/javascript").set("Cache-Control", "public, max-age=300").send(supportWidget);
  });
  for (const mode of ["public", "account"] as const) {
    router.get(`/support-assistant/${mode === "public" ? "embed" : "portal"}`, enabled, (_req, res) => {
      const nonce = randomBytes(18).toString("base64");
      res.type("html").set({
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${mode === "public" ? "https://sdrdl.com https://www.sdrdl.com 'self'" : "'none'"}`,
      }).send(supportPage(mode, nonce));
    });
  }

  async function reply(req: Request, res: Response, next: NextFunction, account: boolean) {
    res.set("Cache-Control", "no-store");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    try {
      const message = validateSupportMessage(req.body);
      const userId = (req as Request & { user?: { id: string } }).user?.id;
      const scope = account
        ? await resolveSupportScope(userId!, req.get("x-provider-organization-id"))
        : null;
      const result = await answerSupport({
        client: getAiClient(), message, scope, lookup: lookupSupportData,
        model: process.env.SUPPORT_ASSISTANT_MODEL || "gpt-5-mini", signal: controller.signal,
      });
      if (scope) {
        await writeAuditLog({ req, userId, organizationId: scope.providerOrganizationId,
          action: "support_assistant_answer", entityType: "support_assistant",
          metadataJson: { mode: "account" },
        });
      }
      return res.json({ ok: true, data: result });
    } catch (error) {
      if (error instanceof SupportError) return res.status(error.statusCode).json({ error: error.message });
      if (error instanceof HttpError) return next(error);
      // Do not return SDK, SQL, credentials, tool text or patient text in errors.
      return res.status(503).json({ error: "The assistant is temporarily unavailable. Please try again or contact the lab." });
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
    }
  }
  router.post("/support-assistant/public", enabled, publicLimit, (req, res, next) => void reply(req, res, next, false));
  router.post("/support-assistant/account", enabled, requireAuth, requireVerifiedAccount, accountLimit,
    (req, res, next) => void reply(req, res, next, true));
}
