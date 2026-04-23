import type { Request } from "express";

type NormalizeOriginOptions = {
  stripPort?: boolean;
};

function isLoopbackHostname(hostname: string | null | undefined): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const value = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(value);
  } catch {
    return null;
  }
}

export function normalizeOrigin(
  input: string | null | undefined,
  options: NormalizeOriginOptions = {},
): string | null {
  if (!input) {
    return null;
  }

  const url = toUrl(input);
  if (!url) {
    return null;
  }

  if (options.stripPort) {
    url.port = "";
  }

  return url.origin;
}

export function getOriginHostname(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }

  const url = toUrl(input);
  return url?.hostname ?? null;
}

export function isLoopbackOrigin(input: string | null | undefined): boolean {
  return isLoopbackHostname(getOriginHostname(input));
}

export function getAllowedOriginHostnames(): Set<string> {
  const hostnames = new Set<string>();

  const addHostname = (value: string | null | undefined, stripPort = false) => {
    const origin = normalizeOrigin(value, { stripPort });
    const hostname = getOriginHostname(origin);
    if (hostname) {
      hostnames.add(hostname);
    }
  };

  addHostname(process.env.REPLIT_DEV_DOMAIN);
  addHostname(process.env.REPLIT_INTERNAL_APP_DOMAIN);
  addHostname(process.env.EXPO_PUBLIC_DOMAIN);
  addHostname(process.env.EXPO_PUBLIC_DOMAIN, true);

  if (process.env.REPLIT_DOMAINS) {
    process.env.REPLIT_DOMAINS.split(",").forEach((domain) => {
      addHostname(domain.trim());
    });
  }

  return hostnames;
}

export function getRequestOrigin(
  req: Pick<Request, "header" | "get" | "protocol">,
): string | null {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host");

  if (!host) {
    return null;
  }

  return normalizeOrigin(`${protocol}://${host}`);
}

export function getReplitBackendOrigin(): string | null {
  const replitDevDomain = process.env.REPLIT_DEV_DOMAIN?.trim();
  const port = process.env.PORT?.trim() || "5000";

  return (
    normalizeOrigin(process.env.REPLIT_INTERNAL_APP_DOMAIN) ??
    normalizeOrigin(process.env.EXPO_PUBLIC_DOMAIN) ??
    (replitDevDomain ? normalizeOrigin(`${replitDevDomain}:${port}`) : null)
  );
}

export function getReplitWebOrigin(): string | null {
  return (
    normalizeOrigin(process.env.REPLIT_DEV_DOMAIN) ??
    normalizeOrigin(process.env.EXPO_PUBLIC_DOMAIN, { stripPort: true })
  );
}
