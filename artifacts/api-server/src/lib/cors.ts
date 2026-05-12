import type { CorsOptions } from "cors";

function buildAllowedOrigins(): Set<string> {
  const allowed = new Set<string>();
  const fromList = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  for (const d of fromList) allowed.add(`https://${d}`);
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) allowed.add(`https://${dev}`);
  // LabTrax Desktop (Electron) renderer is served from a custom protocol
  // (`app://labtrax`). All requests it makes to the API are cross-origin, so
  // the origin must be on the allowlist for the browser to accept the
  // response. Desktop auth uses bearer tokens — not cookies — so SameSite
  // restrictions don't apply, but CORS still does.
  allowed.add("app://labtrax");
  if (process.env.NODE_ENV !== "production") {
    // Common local origins used during development.
    allowed.add("http://localhost");
    allowed.add("http://127.0.0.1");
    for (const port of [80, 3000, 5173, 8080]) {
      allowed.add(`http://localhost:${port}`);
      allowed.add(`http://127.0.0.1:${port}`);
    }
  }
  return allowed;
}

const allowedOrigins = buildAllowedOrigins();

export const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, cb) {
    // Same-origin browser requests, mobile native fetch, and tools like curl
    // do not send an Origin header — allow those through. Cookie-auth still
    // requires a matching SameSite=Lax context to be sent by the browser.
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    return cb(null, false);
  },
};
