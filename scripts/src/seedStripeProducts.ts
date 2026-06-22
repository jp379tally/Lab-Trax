/**
 * Idempotent script to create LabTrax subscription products and prices in Stripe.
 *
 * Creates four plans:
 *   - LabTrax Lab — Monthly ($299/mo) and Annual ($3,229.20/yr, 10% discount)
 *   - LabTrax Provider — Monthly ($49/mo) and Annual ($490/yr)
 *
 * Run with: pnpm --filter @workspace/scripts run seed-stripe-products
 *
 * Prerequisites: Stripe integration must be connected in Replit.
 *
 * After running, set the env vars printed at the end:
 *   STRIPE_PRICE_ID_LAB_MONTHLY
 *   STRIPE_PRICE_ID_LAB_ANNUAL
 *   STRIPE_PRICE_ID_PROVIDER_MONTHLY
 *   STRIPE_PRICE_ID_PROVIDER_ANNUAL
 *   STRIPE_PRICE_ID  (default — set to lab monthly for backwards compat)
 *
 * If a price's unit_amount no longer matches the definition, the old price is
 * archived and a new one is created. Re-point the env vars to the new IDs printed.
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

interface PlanDef {
  productName: string;
  productDescription: string;
  planType: "lab" | "provider";
  prices: Array<{
    interval: "month" | "year";
    unitAmount: number;
    nickname: string;
  }>;
}

const PLANS: PlanDef[] = [
  {
    productName: "LabTrax Lab",
    productDescription:
      "Full access to LabTrax for dental laboratories — case tracking, invoicing, finance, and all lab management features.",
    planType: "lab",
    prices: [
      { interval: "month", unitAmount: 29900, nickname: "LabTrax Lab Monthly" },
      { interval: "year",  unitAmount: 322920, nickname: "LabTrax Lab Annual" },
    ],
  },
  {
    productName: "LabTrax Provider",
    productDescription:
      "LabTrax access for dental providers and practices — case submission, tracking, and communication with your lab.",
    planType: "provider",
    prices: [
      { interval: "month", unitAmount: 4900, nickname: "LabTrax Provider Monthly" },
      { interval: "year",  unitAmount: 49000, nickname: "LabTrax Provider Annual" },
    ],
  },
];

async function seedStripeProducts() {
  const { default: Stripe } = await import("stripe");
  const { secretKey } = await getStripeCredentials();
  const stripe = new Stripe(secretKey);

  console.log("Seeding LabTrax subscription products and prices in Stripe...\n");

  const priceIds: Record<string, string> = {};

  for (const plan of PLANS) {
    console.log(`\n── ${plan.productName} ──`);

    const existing = await stripe.products.search({
      query: `name:'${plan.productName}' AND active:'true'`,
    });

    let productId: string;
    if (existing.data.length > 0) {
      productId = existing.data[0].id;
      console.log(`  Product already exists: ${productId}`);
      await stripe.products.update(productId, {
        metadata: { planType: plan.planType },
      });
    } else {
      const product = await stripe.products.create({
        name: plan.productName,
        description: plan.productDescription,
        metadata: { planType: plan.planType },
      });
      productId = product.id;
      console.log(`  Created product: ${product.name} (${productId})`);
    }

    const existingPrices = await stripe.prices.list({
      product: productId,
      active: true,
    });

    for (const priceDef of plan.prices) {
      const existing = existingPrices.data.find(
        (p) => p.recurring?.interval === priceDef.interval
      );

      const intervalKey =
        `${plan.planType}_${priceDef.interval === "month" ? "monthly" : "annual"}`;

      if (existing && existing.unit_amount === priceDef.unitAmount) {
        console.log(
          `  Price (${priceDef.interval}): already exists at correct amount — ${existing.id}`
        );
        priceIds[intervalKey] = existing.id;
      } else if (existing) {
        console.log(
          `  Price (${priceDef.interval}): amount mismatch (was $${((existing.unit_amount ?? 0) / 100).toFixed(2)}, now $${(priceDef.unitAmount / 100).toFixed(2)}) — archiving ${existing.id}`
        );
        await stripe.prices.update(existing.id, { active: false });
        console.log(`    Archived old price ${existing.id}. New price will be created.`);
        console.log(`    ⚠️  Update env vars to the new price IDs printed below.`);
      }

      if (!existing || existing.unit_amount !== priceDef.unitAmount) {
        const price = await stripe.prices.create({
          product: productId,
          unit_amount: priceDef.unitAmount,
          currency: "usd",
          recurring: { interval: priceDef.interval },
          nickname: priceDef.nickname,
          metadata: { planType: plan.planType, interval: priceDef.interval },
        });
        console.log(
          `  Created price (${priceDef.interval}): $${(priceDef.unitAmount / 100).toFixed(2)}/${priceDef.interval} — ${price.id}`
        );
        priceIds[intervalKey] = price.id;
      }
    }
  }

  console.log("\n\n══ Stripe setup complete. Set these environment variables: ══");
  for (const [key, id] of Object.entries(priceIds)) {
    const envKey = `STRIPE_PRICE_ID_${key.toUpperCase()}`;
    console.log(`  ${envKey}=${id}`);
  }
  if (priceIds["lab_monthly"]) {
    console.log(`  STRIPE_PRICE_ID=${priceIds["lab_monthly"]}   # default (lab monthly)`);
  }
  console.log("\nDone.");
}

seedStripeProducts().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
