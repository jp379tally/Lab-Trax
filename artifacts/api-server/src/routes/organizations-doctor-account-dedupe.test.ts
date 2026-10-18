/**
 * Regression coverage for Task #4372 — "Stop duplicate doctor accounts from
 * being created".
 *
 * An account number may only be issued when a provider signs up on the
 * provider portal, someone signs up on the lab side, or a lab deliberately
 * creates an account for a provider. These tests pin the three lab-side paths
 * that used to mint a second account (and a second account number) for a
 * doctor who already had one:
 *
 *   - Add doctor → "New doctor" (previously deduped on an exact email only)
 *   - Add doctor → adopting a case-history (name-only) doctor (previously an
 *     exact trimmed/lowercased name match)
 *   - Remove / reassign a name-only doctor (previously promoted the typed
 *     name into a brand-new account)
 *
 * Repeating any of them, with or without an email and with or without a "Dr."
 * prefix or a middle initial, must end with exactly ONE account carrying ONE
 * account number.
 *
 * Signup is the deliberate exception and is pinned here too: it is a
 * sanctioned trigger, but it must NEVER reuse a matched account. Handing a
 * person who just registered the credentials and case history of an existing
 * same-named doctor would be an authentication hazard, so signup only records
 * creation provenance. Those two tests sit next to the reuse tests so the
 * opposite behaviours are read together.
 *
 * Skipped when no DATABASE_URL is configured — same convention as the other
 * route integration tests.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Task #4372 provider-account creation gate (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let providerAccount: typeof import("../lib/provider-account.js");

  const labOrgId = rid("lab");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");
  const adminUserId = rid("uadmin");
  let adminToken = "";

  // Provider accounts created by the endpoints under test — cleaned up after
  // each test so a repeated run starts from the same empty lab.
  const trackUsers: string[] = [];
  const trackCases: string[] = [];

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const token = auth.signAccessToken(userId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return token;
  }

  async function addCase(doctorName: string, practiceId: string) {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName,
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    trackCases.push(id);
    return id;
  }

  function addDoctors(
    practiceId: string,
    doctors: Array<{
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
    }>
  ) {
    return request(appMod.default)
      .post(`/api/organizations/${practiceId}/doctors`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctors });
  }

  function track(res: request.Response) {
    for (const row of res.body?.data?.created ?? []) trackUsers.push(row.id);
    for (const row of res.body?.data?.reused ?? []) trackUsers.push(row.id);
    return res;
  }

  /**
   * Self-service provider signup that asks to join practice A, so the new
   * account carries a practice in its creation provenance. Username, email,
   * and password are unique per call — only the doctor's NAME collides with
   * the account the lab already has. The new account is tracked for teardown.
   */
  async function signUpProvider(doctor: {
    firstName: string;
    lastName: string;
  }) {
    const suffix = randomBytes(4).toString("hex");
    const res = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: `sg${suffix}`,
        password: "SignupPassword1!",
        email: `signup_${suffix}@example.test`,
        userType: "provider",
        firstName: doctor.firstName,
        lastName: doctor.lastName,
        doctorName: `${doctor.firstName} ${doctor.lastName}`,
        joinOrganizationId: practiceAId,
        clientType: "mobile",
      });
    if (res.body?.user?.id) trackUsers.push(res.body.user.id);
    return res;
  }

  /** Every non-deleted provider account whose name normalizes to `name`. */
  async function providerAccountsNamed(name: string) {
    const { db, users } = dbMod as any;
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.userType, "provider"), isNull(users.deletedAt)));
    const wanted = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return rows.filter((u: any) => {
      const candidates = [
        `${u.firstName ?? ""} ${u.lastName ?? ""}`,
        u.doctorName ?? "",
      ];
      return candidates.some(
        (c) =>
          c
            .toLowerCase()
            .replace(/\bdr\.?\b/g, "")
            .replace(/[^a-z0-9]+/g, " ")
            .trim() === wanted
      );
    });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-4372";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    providerAccount = await import("../lib/provider-account.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;
    await db
      .insert(users)
      .values([{ id: adminUserId, username: `adm_${adminUserId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("Dedupe Lab") },
      {
        id: practiceAId,
        type: "provider",
        name: rid("Practice A"),
        parentLabOrganizationId: labOrgId,
      },
      {
        id: practiceBId,
        type: "provider",
        name: rid("Practice B"),
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
    ]);
  });

  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    adminToken = await makeSession(adminUserId);
  });

  afterEach(async () => {
    const {
      db,
      auditLogs,
      cases,
      organizationJoinRequests,
      organizationMemberships,
      labUnassignedDoctors,
      users,
      userSessions,
    } = dbMod as any;
    if (trackCases.length) {
      await db.delete(cases).where(inArray(cases.id, trackCases));
    }
    // Name-only holding entries have no user id — clear them per lab.
    await db
      .delete(labUnassignedDoctors)
      .where(eq(labUnassignedDoctors.labOrganizationId, labOrgId));
    if (trackUsers.length) {
      // Signup leaves a session, a pending join request, and audit rows
      // behind. Clear them before the user delete so nothing survives the
      // fixture (audit rows would otherwise be orphaned with a null user).
      await db
        .delete(organizationJoinRequests)
        .where(inArray(organizationJoinRequests.userId, trackUsers));
      await db
        .delete(userSessions)
        .where(inArray(userSessions.userId, trackUsers));
      await db.delete(auditLogs).where(inArray(auditLogs.userId, trackUsers));
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, trackUsers));
      await db.delete(users).where(inArray(users.id, trackUsers));
    }
    trackCases.length = 0;
    trackUsers.length = 0;
  });

  afterAll(async () => {
    const {
      db,
      auditLogs,
      organizations,
      users,
      organizationMemberships,
      userSessions,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [practiceAId, practiceBId]));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, practiceAId, practiceBId]));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("adding the same email-less doctor repeatedly reuses one account and one number", async () => {
    const first = rid("Brittney");
    const last = rid("Craig");

    const one = track(await addDoctors(practiceAId, [{ firstName: first, lastName: last }]));
    expect(one.status).toBe(201);
    expect(one.body.data.created.length).toBe(1);
    expect(one.body.data.skipped.length).toBe(0);
    const accountId = one.body.data.created[0].id;
    const accountNumber = one.body.data.created[0].platformAccountNumber;
    expect(accountNumber).toBeTruthy();

    // Same person again — no email to dedupe on, and a "Dr." prefix plus a
    // middle initial this time.
    for (const name of [
      { firstName: first, lastName: last },
      { firstName: `Dr. ${first}`, lastName: last },
      { firstName: `${first} K.`, lastName: last },
    ]) {
      const again = track(await addDoctors(practiceAId, [name]));
      expect(again.status).toBe(201);
      expect(again.body.data.created.length).toBe(0);
      expect(again.body.data.skipped.length).toBe(0);
      expect(again.body.data.reused.length).toBe(1);
      expect(again.body.data.reused[0].id).toBe(accountId);
      // The lab admin is told which existing account was attached.
      expect(again.body.data.reused[0].platformAccountNumber).toBe(accountNumber);
      expect(again.body.data.reused[0].matchedOn).toBe("name");
    }

    // Exactly one account for that person, and one account number.
    const accounts = await providerAccountsNamed(`${first} ${last}`);
    expect(accounts.length).toBe(1);
    expect(accounts[0].id).toBe(accountId);
    expect(accounts[0].platformAccountNumber).toBe(accountNumber);
  });

  it("records the sanctioned trigger, actor, and practice on a new account", async () => {
    const first = rid("Blake");
    const last = rid("Garfinkel");
    const res = track(await addDoctors(practiceAId, [{ firstName: first, lastName: last }]));
    expect(res.status).toBe(201);
    const created = res.body.data.created[0];

    const { db, users } = dbMod as any;
    const [row] = await db.select().from(users).where(eq(users.id, created.id));
    expect(row.accountCreationTrigger).toBe("lab_created_account");
    expect(row.accountCreatedByUserId).toBe(adminUserId);
    expect(row.accountCreatedForOrganizationId).toBe(practiceAId);
  });

  it("signing up never lands the new provider in an existing same-named account", async () => {
    const first = rid("Signup");
    const last = rid("Namesake");

    // The lab already has an account for a doctor with this name. Every
    // lab-side path above would reuse it.
    const lab = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
    );
    expect(lab.status).toBe(201);
    const labAccountId = lab.body.data.created[0].id;
    const labAccountNumber = lab.body.data.created[0].platformAccountNumber;
    expect(labAccountNumber).toBeTruthy();

    // The shared resolver DOES match this identity, so a lab-side path would
    // have reused the account. Asserting it here keeps the test below from
    // passing vacuously because the names happened not to collide.
    const wouldMatch = await providerAccount.resolveExistingProviderAccount(
      (dbMod as any).db,
      { firstName: first, lastName: last },
      { labOrganizationId: labOrgId }
    );
    expect(wouldMatch?.user.id).toBe(labAccountId);

    // Someone registers themselves under the very same name. Signup must NOT
    // take the reuse branch: it would hand the registrant the existing
    // doctor's credentials and history.
    const signup = await signUpProvider({ firstName: first, lastName: last });
    expect(signup.status).toBe(200);
    const newAccount = signup.body.user;
    expect(newAccount.id).toBeTruthy();
    expect(newAccount.id).not.toBe(labAccountId);
    expect(newAccount.platformAccountNumber).toBeTruthy();
    expect(newAccount.platformAccountNumber).not.toBe(labAccountNumber);

    // Two distinct accounts under that name, each with its own number, and
    // the lab's original account is untouched.
    const accounts = await providerAccountsNamed(`${first} ${last}`);
    expect(accounts.length).toBe(2);
    expect(
      new Set(accounts.map((a: any) => a.platformAccountNumber)).size
    ).toBe(2);

    const { db, users } = dbMod as any;
    const [labRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, labAccountId));
    expect(labRow.platformAccountNumber).toBe(labAccountNumber);
  });

  it("records the sanctioned trigger, actor, and practice on a signup account", async () => {
    const first = rid("Signup");
    const last = rid("Provenance");

    // Same collision as above, so this pins the provenance of the account
    // signup created *instead of* reusing the lab's.
    const lab = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
    );
    expect(lab.status).toBe(201);

    const signup = await signUpProvider({ firstName: first, lastName: last });
    expect(signup.status).toBe(200);

    const { db, users } = dbMod as any;
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, signup.body.user.id));
    expect(row.accountCreationTrigger).toBe("provider_portal_signup");
    // Self-service signup — the new account is its own actor, never a lab
    // admin the way a lab-created account is.
    expect(row.accountCreatedByUserId).toBeNull();
    expect(row.accountCreatedForOrganizationId).toBe(practiceAId);
  });

  it("reuses the existing account when the doctor is re-added by email", async () => {
    const first = rid("Email");
    const last = rid("Match");
    const email = `${first}.${last}@example.test`.toLowerCase();

    const one = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last, email }])
    );
    expect(one.status).toBe(201);
    const accountId = one.body.data.created[0].id;

    // Same email, a completely different spelling of the name.
    const two = track(
      await addDoctors(practiceAId, [
        { firstName: "Someone", lastName: "Else", email: email.toUpperCase() },
      ])
    );
    expect(two.status).toBe(201);
    expect(two.body.data.created.length).toBe(0);
    expect(two.body.data.reused.length).toBe(1);
    expect(two.body.data.reused[0].id).toBe(accountId);
    expect(two.body.data.reused[0].matchedOn).toBe("email");

    // And the same name with no email at all.
    const three = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
    );
    expect(three.body.data.reused[0].id).toBe(accountId);

    const accounts = await providerAccountsNamed(`${first} ${last}`);
    expect(accounts.length).toBe(1);
  });

  it("adopting a case-history name variant reuses the existing account", async () => {
    const first = rid("Adopt");
    const last = rid("Variant");

    const one = track(await addDoctors(practiceAId, [{ firstName: first, lastName: last }]));
    const accountId = one.body.data.created[0].id;
    const accountNumber = one.body.data.created[0].platformAccountNumber;

    // Case history spells the doctor differently.
    const variant = `Dr. ${first} K. ${last}`;
    await addCase(variant, practiceBId);

    const adopt = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/adopt`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctorName: variant, sourceOrganizationId: practiceBId });
    expect(adopt.status).toBe(201);
    if (adopt.body.data?.userId) trackUsers.push(adopt.body.data.userId);

    expect(adopt.body.data.createdNewAccount).toBe(false);
    expect(adopt.body.data.userId).toBe(accountId);
    expect(adopt.body.data.platformAccountNumber).toBe(accountNumber);

    const accounts = await providerAccountsNamed(`${first} ${last}`);
    expect(accounts.length).toBe(1);
  });

  it("removing a name-only doctor creates no account and no account number", async () => {
    const doctorName = `Dr. ${rid("NameOnly")} ${rid("Doctor")}`;
    await addCase(doctorName, practiceAId);

    const { db, users, labUnassignedDoctors } = dbMod as any;
    const before = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userType, "provider"));

    const removed = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/remove`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctorName });
    expect(removed.status).toBe(200);
    expect(removed.body.data.userId).toBeNull();
    expect(removed.body.data.promotedFromVirtual).toBe(false);
    expect(removed.body.data.platformAccountNumber).toBeNull();

    const after = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userType, "provider"));
    expect(after.length).toBe(before.length);

    // The removal is held by name so the lab can still reassign the doctor.
    const holding = await db
      .select()
      .from(labUnassignedDoctors)
      .where(
        and(
          eq(labUnassignedDoctors.labOrganizationId, labOrgId),
          isNull(labUnassignedDoctors.userId),
          isNull(labUnassignedDoctors.deletedAt)
        )
      );
    expect(holding.length).toBe(1);
    expect(holding[0].doctorName).toBe(doctorName);

    // The held doctor is listed, flagged as having no account.
    const list = await request(appMod.default)
      .get(`/api/organizations/${labOrgId}/unassigned-doctors`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const entry = (list.body.data ?? []).find(
      (d: any) => d.doctorName === doctorName
    );
    expect(entry).toBeDefined();
    expect(entry.userId).toBeNull();
    expect(entry.hasAccount).toBe(false);

    // Reassigning them moves their cases, still without creating an account.
    const reassign = await request(appMod.default)
      .post(`/api/organizations/unassigned-doctors/reassign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName,
        destinationOrganizationId: practiceBId,
        existingCases: "move",
      });
    expect(reassign.status).toBe(200);
    expect(reassign.body.data.userId).toBeNull();
    expect(reassign.body.data.casesMoved).toBe(1);

    const stillSame = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userType, "provider"));
    expect(stillSame.length).toBe(before.length);
  });

  it("reassigning a name-only doctor with an existing account never creates a second one", async () => {
    const first = rid("Reassign");
    const last = rid("Existing");
    const one = track(await addDoctors(practiceAId, [{ firstName: first, lastName: last }]));
    const accountId = one.body.data.created[0].id;

    // A case spelled slightly differently keeps the doctor visible as a
    // name-only row in the practice's Doctors list.
    await addCase(`Dr. ${first} ${last}`, practiceAId);

    const removed = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/remove`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorName: `Dr. ${first} ${last}`,
        destinationOrganizationId: practiceBId,
        existingCases: "move",
      });
    expect(removed.status).toBe(200);
    expect(removed.body.data.userId).toBe(accountId);
    expect(removed.body.data.reusedExistingAccount).toBe(true);

    const accounts = await providerAccountsNamed(`${first} ${last}`);
    expect(accounts.length).toBe(1);
  });

  it("repeated add → remove → add cycles leave exactly one account", async () => {
    const first = rid("Cycle");
    const last = rid("Doctor");
    let accountId: string | null = null;
    let accountNumber: string | null = null;

    for (let i = 0; i < 3; i++) {
      const add = track(
        await addDoctors(practiceAId, [
          i % 2 === 0
            ? { firstName: first, lastName: last }
            : { firstName: `Dr. ${first}`, lastName: last },
        ])
      );
      expect(add.status).toBe(201);
      const row = add.body.data.created[0] ?? add.body.data.reused[0];
      expect(row, JSON.stringify(add.body.data)).toBeDefined();
      if (accountId) {
        expect(row.id).toBe(accountId);
        expect(row.platformAccountNumber).toBe(accountNumber);
      } else {
        accountId = row.id;
        accountNumber = row.platformAccountNumber;
      }

      const remove = await request(appMod.default)
        .post(`/api/organizations/${practiceAId}/doctors/remove`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: accountId, doctorName: `${first} ${last}` });
      expect(remove.status).toBe(200);
    }

    const accounts = await providerAccountsNamed(`${first} ${last}`);
    expect(accounts.length).toBe(1);
    const { db, users } = dbMod as any;
    const numbered = await db
      .select({ n: users.platformAccountNumber })
      .from(users)
      .where(
        and(
          eq(users.userType, "provider"),
          sql`${users.platformAccountNumber} = ${accountNumber}`
        )
      );
    expect(numbered.length).toBe(1);
  });
});
