import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routesDir = path.resolve(import.meta.dirname);
const read = (file: string) => fs.readFileSync(path.join(routesDir, file), "utf8");

function routeHandler(source: string, method: "get" | "post", route: string): string {
  const marker = `router.${method}(\n  "${route}"`;
  // A handler may intentionally serve a legacy route and a more-specific
  // contract variant (for example "/" and "/worklist") from one authorization
  // boundary.
  const arrayMarker = `router.${method}(\n  ["${route}"`;
  const start = Math.max(source.indexOf(marker), source.indexOf(arrayMarker));
  if (start < 0) throw new Error(`Route not found: ${method.toUpperCase()} ${route}`);
  const nextRoute = source.indexOf("\nrouter.", start + marker.length);
  return source.slice(start, nextRoute < 0 ? source.length : nextRoute);
}

function expectNoBroadReads(source: string): void {
  expect(source).not.toMatch(/\.select\(\s*\)/);
  const relationalReads = source.match(/\.(?:findFirst|findMany)\(\{/g) ?? [];
  const explicitRelationalColumns = source.match(/\bcolumns:\s*(?:\{|[A-Za-z])/g) ?? [];
  expect(explicitRelationalColumns.length).toBeGreaterThanOrEqual(
    relationalReads.length,
  );
}

describe("core reads remain isolated from additive schema columns", () => {
  it("keeps login and current-user reads on explicit projections", () => {
    const auth = read("auth.ts");
    const middleware = fs.readFileSync(
      path.resolve(routesDir, "../middlewares/auth.ts"),
      "utf8",
    );

    const login = routeHandler(auth, "post", "/login");
    const currentUser = routeHandler(auth, "get", "/me");

    expect(login).toContain(".select(loginUserColumns).from(users)");
    expect(login).toContain("hydrateUsersWithActiveMemberships([user])");
    expect(currentUser).toContain(".select(loginOrganizationColumns)");
    expect(currentUser).toContain("hydrateUsersWithActiveMemberships([user])");
    expectNoBroadReads(login);
    expectNoBroadReads(currentUser);
    expectNoBroadReads(
      auth.slice(
        auth.indexOf("async function hydrateUsersWithActiveMemberships"),
        auth.indexOf("\nconst registerSchema"),
      ),
    );
    // The session predicate is now joined into the explicitly projected user
    // read; never expand it into SELECT * from either additive table.
    expect(middleware).toMatch(/\.select\(authUserColumns\)[\s\S]*?\.from\(userSessions\)[\s\S]*?\.innerJoin\(users,/);
    expectNoBroadReads(middleware);
    expect(middleware).toContain("isNull(userSessions.revokedAt)");
  });

  it("keeps cases and organizations list reads on explicit projections", () => {
    const cases = read("cases.ts");
    const organizations = read("organizations.ts");
    const caseList = routeHandler(cases, "get", "/");
    const organizationList = routeHandler(organizations, "get", "/");

    expect(caseList.match(/columns: caseListColumns/g)).toHaveLength(4);
    expect(caseList).toContain("columns: caseListRestorationColumns");
    expect(caseList).toContain(".select(legacyCaseListColumns)");
    expectNoBroadReads(caseList);
    expect(cases).toMatch(
      /const caseListColumns = \{[\s\S]*?labLocationId:\s*true/,
    );
    expect(organizationList).toContain(".select(organizationListColumns)");
    expectNoBroadReads(organizationList);
    expect(organizations).toMatch(
      /const organizationListColumns = \{[\s\S]*?deletedByUserId:/,
    );
  });

  it("keeps notification and billing reads on explicit projections", () => {
    const notifications = read("notifications.ts");
    const billing = read("billing.ts");
    const notificationList = routeHandler(notifications, "get", "/");
    const billingSubscription = routeHandler(billing, "get", "/subscription");

    expect(notificationList).toContain(".select(notificationReadColumns)");
    expectNoBroadReads(notificationList);
    expect(notifications).toContain(".returning(notificationReadColumns)");
    expect(billingSubscription).toMatch(
      /\.select\(\{[\s\S]*?cancelAtPeriodEnd:/,
    );
    expectNoBroadReads(billingSubscription);
  });
});