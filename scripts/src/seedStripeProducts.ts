/**
 * Idempotent script to create LabTrax subscription products and prices in Stripe.
 *
 * Run with: pnpm --filter @workspace/scripts run seed-stripe-products
 *
 * Prerequisites: Stripe integration must be connected in Replit.
 */

async function getStripeCredentials(): Promise<{ secretKey: string }> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Stripe integration is not configured. Connect it via the Replit Integrations tab."
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to fetch Stripe credentials: ${resp.status}`);
  }

  const data = await resp.json() as Record<string, any>;
  const secretKey = data.items?.[0]?.settings?.secret_key;
  if (!secretKey) {
    throw new Error("Stripe secret key not found in connector settings.");
  }

  return { secretKey };
}

async function seedStripeProducts() {
  const { default: Stripe } = await import("stripe");
  const { secretKey } = await getStripeCredentials();
  const stripe = new Stripe(secretKey);

  console.log("Checking for existing LabTrax subscription products...");

  const existing = await stripe.products.search({
    query: "name:'LabTrax Pro' AND active:'true'",
  });

  let productId: string;

  if (existing.data.length > 0) {
    productId = existing.data[0].id;
    console.log(`Product already exists: ${productId}`);
  } else {
    const product = await stripe.products.create({
      name: "LabTrax Pro",
      description:
        "Full access to LabTrax — case tracking, invoicing, and all lab management features.",
    });
    productId = product.id;
    console.log(`Created product: ${product.name} (${productId})`);
  }

  const existingPrices = await stripe.prices.list({
    product: productId,
    active: true,
  });

  const hasMonthly = existingPrices.data.some(
    (p) => p.recurring?.interval === "month"
  );
  const hasYearly = existingPrices.data.some(
    (p) => p.recurring?.interval === "year"
  );

  if (!hasMonthly) {
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: 4900,
      currency: "usd",
      recurring: { interval: "month" },
    });
    console.log(`Created monthly price: $49.00/month (${price.id})`);
    console.log(`\nSet STRIPE_PRICE_ID=${price.id} to use this price as the default.`);
  } else {
    const p = existingPrices.data.find((p) => p.recurring?.interval === "month");
    console.log(`Monthly price already exists: ${p?.id}`);
    console.log(`\nSet STRIPE_PRICE_ID=${p?.id} to use this price as the default.`);
  }

  if (!hasYearly) {
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: 49000,
      currency: "usd",
      recurring: { interval: "year" },
    });
    console.log(`Created yearly price: $490.00/year (${price.id})`);
  } else {
    const p = existingPrices.data.find((p) => p.recurring?.interval === "year");
    console.log(`Yearly price already exists: ${p?.id}`);
  }

  console.log("\nDone. Stripe products and prices are ready.");
}

seedStripeProducts().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
