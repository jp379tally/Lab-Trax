import Stripe from "stripe";
import { logger } from "./logger";

/**
 * Fetch Stripe credentials from the Replit connector proxy.
 * Returns null when the Stripe integration is not configured.
 */
async function getStripeCredentials(): Promise<{
  secretKey: string;
  webhookSecret?: string;
} | null> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    return null;
  }

  try {
    const resp = await fetch(
      `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
      {
        headers: {
          Accept: "application/json",
          X_REPLIT_TOKEN: xReplitToken,
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        "[stripe] Failed to fetch credentials from Replit connector"
      );
      return null;
    }

    const data = await resp.json() as Record<string, any>;
    const settings = data.items?.[0]?.settings;

    if (!settings?.secret_key) {
      return null;
    }

    return {
      secretKey: settings.secret_key,
      webhookSecret: settings.webhook_secret,
    };
  } catch (err: any) {
    logger.warn(
      { err: err?.message },
      "[stripe] Error fetching credentials — Stripe features disabled"
    );
    return null;
  }
}

/**
 * Returns true when the Stripe integration is wired up and a secret key
 * is available. Use this to gate billing routes.
 */
export async function isStripeConfigured(): Promise<boolean> {
  const creds = await getStripeCredentials();
  return creds !== null;
}

/**
 * Returns a fresh authenticated Stripe client, or null if not configured.
 * Not cached — fetches credentials on every call so rotated keys are
 * picked up automatically.
 */
export async function getUncachableStripeClient(): Promise<Stripe | null> {
  const creds = await getStripeCredentials();
  if (!creds) return null;
  return new Stripe(creds.secretKey);
}

/**
 * Logs the Stripe account display name and ID at startup so operators can
 * confirm that subscription revenue settles into the correct Stripe account.
 * Non-fatal: a retrieval failure emits WARN but does not block startup.
 */
export async function logStripeAccountOwnership(): Promise<void> {
  const creds = await getStripeCredentials();
  if (!creds) {
    logger.warn("[stripe] Stripe not configured — skipping account ownership check");
    return;
  }
  try {
    const stripe = new Stripe(creds.secretKey);
    // Pass "" to retrieve the platform's own account (Stripe v22+ requires an explicit id arg).
    const account = await stripe.accounts.retrieve("");
    logger.info(
      {
        stripeAccountId: account.id,
        stripeAccountName: account.business_profile?.name ?? account.email ?? "(unnamed)",
        stripeAccountEmail: account.email ?? null,
        stripeAccountCountry: account.country ?? null,
      },
      "[stripe] Revenue account verified — confirm this is the intended LabTrax/SDR account"
    );
  } catch (err: any) {
    logger.warn(
      { err: err?.message },
      "[stripe] Could not retrieve Stripe account info — verify STRIPE_SECRET_KEY belongs to the correct account"
    );
  }
}

/**
 * Construct and verify a Stripe webhook event from a raw request payload.
 * Returns null when Stripe is not configured or the signature is invalid.
 */
export async function constructStripeEvent(
  payload: Buffer,
  signature: string
): Promise<Stripe.Event | null> {
  const creds = await getStripeCredentials();
  if (!creds?.webhookSecret) {
    logger.warn("[stripe] No webhook secret — cannot verify webhook");
    return null;
  }

  try {
    const stripe = new Stripe(creds.secretKey);
    return stripe.webhooks.constructEvent(
      payload,
      signature,
      creds.webhookSecret
    );
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[stripe] Webhook signature verification failed");
    return null;
  }
}
