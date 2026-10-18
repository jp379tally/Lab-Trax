export interface DemoSeedEnvironment {
  NODE_ENV?: string;
  LABTRAX_ENABLE_DEMO_SEEDS?: string;
  LABTRAX_DEMO_SEED_PASSWORD?: string;
}

export const DEFAULT_DEMO_USERS = [
  {
    username: "labadmin_demo",
    userType: "lab",
    role: "admin",
    email: "labadmin_demo@example.test",
    accountNumber: "LAB-001",
  },
  {
    username: "labtech_demo",
    userType: "lab",
    role: "user",
    email: "labtech_demo@example.test",
    accountNumber: "LAB-002",
  },
  {
    username: "master_demo",
    userType: "master_admin",
    role: "admin",
    email: "master_demo@example.test",
    accountNumber: "MA-001",
  },
  {
    username: "provider_demo",
    userType: "provider",
    role: "user",
    email: "provider_demo@example.test",
  },
] as const;

export function resolveDemoSeedPassword(
  env: DemoSeedEnvironment,
): string | null {
  if (
    env.NODE_ENV !== "development" ||
    env.LABTRAX_ENABLE_DEMO_SEEDS !== "true"
  ) {
    return null;
  }

  const password = env.LABTRAX_DEMO_SEED_PASSWORD;
  if (!password || password.trim().length === 0) {
    throw new Error(
      "LABTRAX_DEMO_SEED_PASSWORD is required when demo seeding is explicitly enabled in development.",
    );
  }

  return password;
}
