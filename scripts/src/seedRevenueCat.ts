/**
 * Prints RevenueCat setup instructions for LabTrax.
 *
 * Run with: pnpm --filter @workspace/scripts run seed-revenuecat
 *
 * Unlike the Stripe seed script, this is a guided setup guide because
 * RevenueCat product/entitlement configuration must be done manually in the
 * RevenueCat dashboard and linked to App Store Connect / Google Play Console.
 */

async function seedRevenueCatGuide() {
  const domains = (process.env.REPLIT_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  const base = domains[0] ? `https://${domains[0]}` : "<your-app-url>";

  console.log("=== RevenueCat Setup Guide for LabTrax ===\n");
  console.log("Step 1: Create a RevenueCat account at https://app.revenuecat.com");
  console.log("Step 2: Create a new project for LabTrax");
  console.log("Step 3: Add iOS and/or Android apps in your project\n");

  console.log("Step 4: Create products in App Store Connect / Google Play:");
  console.log("  - Monthly: com.labtrax.subscription.monthly  ($49/mo)");
  console.log("  - Yearly:  com.labtrax.subscription.yearly   ($490/yr)\n");

  console.log("Step 5: In RevenueCat dashboard:");
  console.log("  a. Create an Entitlement with ID: labtrax_pro");
  console.log("  b. Create an Offering with ID:    default");
  console.log("  c. Create a Package (monthly) and attach com.labtrax.subscription.monthly");
  console.log("  d. Create a Package (yearly)  and attach com.labtrax.subscription.yearly\n");

  console.log("Step 6: Configure the webhook in RevenueCat:");
  console.log(`  URL: ${base}/api/billing/webhook/revenuecat`);
  console.log("  Events: All events\n");

  console.log("Step 7: Set these environment variables in Replit:");
  console.log("  EXPO_PUBLIC_REVENUECAT_IOS_API_KEY=<iOS API key from RC dashboard>");
  console.log("  EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY=<Android API key from RC dashboard>\n");

  console.log("Step 8: Retrieve your API keys from RevenueCat Dashboard → API Keys");
  console.log("  Use the PUBLIC key for the mobile app (EXPO_PUBLIC_*)");
  console.log("  Use the SECRET key for the server-side webhook verification\n");

  console.log("Done! After completing these steps, the mobile app will use RevenueCat");
  console.log("for IAP on iOS/Android, and the server will receive real-time subscription");
  console.log("events via the webhook.");
}

seedRevenueCatGuide().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
