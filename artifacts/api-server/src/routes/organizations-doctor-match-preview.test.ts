/**
 * Coverage for Task #4398 — "Warn the admin before adding a doctor who
 * already has an account".
 *
 * Adding a doctor who already has an account attaches that account instead of
 * minting a second one (Task #4372), but the admin only learned about it
 * afterwards. Two things are pinned here:
 *
 *   1. `POST /organizations/:id/doctors/match-preview` reports, read-only and
 *      before submit, exactly the account the add call would attach to. It
 *      must agree with the add call (same resolver, no second matching rule)
 *      and must not create anything.
 *   2. `distinctFromUserIds` — the admin looked at the match and said "that
 *      is a different person". Only the accounts they named are skipped;
 *      everyone else is still matched, and a shared email is still refused.
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
import { and, eq, inArray, isNull } from "drizzle-orm";
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

maybe("Task #4398 add-doctor match preview (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("otherlab");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");
  const outsiderPracticeId = rid("provOut");
  const adminUserId = rid("uadmin");
  const outsiderAdminId = rid("uoutsider");
  let adminToken = "";
  let outsiderToken = "";

  const trackUsers: string[] = [];

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

  function addDoctors(
    practiceId: string,
    doctors: Array<{
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
      distinctFromUserIds?: string[];
    }>,
    token = adminToken
  ) {
    return request(appMod.default)
      .post(`/api/organizations/${practiceId}/doctors`)
      .set("Authorization", `Bearer ${token}`)
      .send({ doctors });
  }

  function preview(
    scopeOrgId: string,
    doctors: Array<{
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      distinctFromUserIds?: string[];
    }>,
    token = adminToken
  ) {
    return request(appMod.default)
      .post(`/api/organizations/${scopeOrgId}/doctors/match-preview`)
      .set("Authorization", `Bearer ${token}`)
      .send({ doctors });
  }

  function track(res: request.Response) {
    for (const row of res.body?.data?.created ?? []) trackUsers.push(row.id);
    for (const row of res.body?.data?.reused ?? []) trackUsers.push(row.id);
    return res;
  }

  /**
   * Provider accounts whose name contains `token`. Scoped to a unique token
   * rather than counting every provider account, because sibling test files
   * run concurrently (vitest maxWorkers=2) and create accounts of their own.
   */
  async function providerAccountsMatching(token: string): Promise<number> {
    const { db, users } = dbMod as any;
    const rows = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        doctorName: users.doctorName,
      })
      .from(users)
      .where(and(eq(users.userType, "provider"), isNull(users.deletedAt)));
    return rows.filter((u: any) =>
      `${u.firstName ?? ""} ${u.lastName ?? ""} ${u.doctorName ?? ""}`.includes(
        token
      )
    ).length;
  }

  /** A 10-digit phone number nothing else in the suite will collide with. */
  function uniquePhone(): string {
    let digits = "";
    while (digits.length < 7) {
      digits += randomBytes(4).readUInt32BE(0).toString().slice(0, 7);
    }
    return `555${digits.slice(0, 7)}`;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-4398";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;
    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      { id: outsiderAdminId, username: `adm_${outsiderAdminId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("Preview Lab") },
      { id: otherLabOrgId, type: "lab", name: rid("Other Lab") },
      {
        id: practiceAId,
        type: "provider",
        name: rid("Practice A"),
        displayName: "Southside Dental",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: practiceBId,
        type: "provider",
        name: rid("Practice B"),
        parentLabOrganizationId: labOrgId,
      },
      {
        id: outsiderPracticeId,
        type: "provider",
        name: rid("Outsider Practice"),
        parentLabOrganizationId: otherLabOrgId,
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
      {
        id: rid("m"),
        labId: otherLabOrgId,
        userId: outsiderAdminId,
        role: "admin",
        status: "active",
      },
    ]);
  });

  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    adminToken = await makeSession(adminUserId);
    outsiderToken = await makeSession(outsiderAdminId);
  });

  afterEach(async () => {
    const { db, organizationMemberships, labUnassignedDoctors, users } =
      dbMod as any;
    await db
      .delete(labUnassignedDoctors)
      .where(eq(labUnassignedDoctors.labOrganizationId, labOrgId));
    if (trackUsers.length) {
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, trackUsers));
      await db.delete(users).where(inArray(users.id, trackUsers));
    }
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
    await db
      .delete(auditLogs)
      .where(
        inArray(auditLogs.organizationId, [
          labOrgId,
          otherLabOrgId,
          practiceAId,
          practiceBId,
          outsiderPracticeId,
        ])
      );
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [adminUserId, outsiderAdminId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId, outsiderAdminId]));
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          labOrgId,
          otherLabOrgId,
          practiceAId,
          practiceBId,
          outsiderPracticeId,
        ])
      );
    await db
      .delete(users)
      .where(inArray(users.id, [adminUserId, outsiderAdminId]));
  });

  it("previews nothing for a name with no existing account, and creates nothing", async () => {
    const token = randomBytes(6).toString("hex");
    const res = await preview(practiceAId, [
      { firstName: `Nobody${token}`, lastName: `Here${token}` },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.matches).toEqual([]);
    // A preview must never mint the account it was asked about.
    expect(await providerAccountsMatching(token)).toBe(0);
  });

  it("warns before submit with the account the add call would attach to", async () => {
    const first = rid("Brittney");
    const last = rid("Craig");

    const created = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
    );
    expect(created.status).toBe(201);
    const account = created.body.data.created[0];
    expect(account.platformAccountNumber).toBeTruthy();

    // Same person, spelled the way an admin would retype it.
    const res = await preview(practiceBId, [
      { firstName: `Dr. ${first} K.`, lastName: last },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.matches.length).toBe(1);

    const match = res.body.data.matches[0];
    expect(match.index).toBe(0);
    expect(match.userId).toBe(account.id);
    expect(match.platformAccountNumber).toBe(account.platformAccountNumber);
    expect(match.matchedOn).toBe("name");
    expect(match.displayName).toContain(first);
    // The practice they already work at, so the admin can judge the match.
    expect(match.practices).toContain("Southside Dental");
    // Not yet at practice B, which is where they're being added.
    expect(match.alreadyMemberOfPractice).toBe(false);

    // The preview is read-only: submitting is what actually attaches.
    await preview(practiceBId, [{ firstName: first, lastName: last }]);
    expect(await providerAccountsMatching(first)).toBe(1);
  });

  it("agrees with the add call on email and phone matches", async () => {
    const first = rid("Email");
    const last = rid("Match");
    const email = `${first}.${last}@example.test`.toLowerCase();
    const phone = uniquePhone();

    const created = track(
      await addDoctors(practiceAId, [
        { firstName: first, lastName: last, email, phone },
      ])
    );
    expect(created.status).toBe(201);
    const accountId = created.body.data.created[0].id;

    // Email beats a completely different name — same as the add call.
    const byEmail = await preview(practiceAId, [
      { firstName: "Someone", lastName: "Else", email: email.toUpperCase() },
    ]);
    expect(byEmail.body.data.matches[0].userId).toBe(accountId);
    expect(byEmail.body.data.matches[0].matchedOn).toBe("email");

    // Phone only counts when the name is compatible, so use the real name.
    const byPhone = await preview(practiceAId, [
      { firstName: first, lastName: last, phone },
    ]);
    expect(byPhone.body.data.matches[0].userId).toBe(accountId);

    // And the add call reaches the same conclusion the warning promised.
    const attached = track(
      await addDoctors(practiceAId, [
        { firstName: "Someone", lastName: "Else", email },
      ])
    );
    expect(attached.status).toBe(201);
    expect(attached.body.data.created.length).toBe(0);
    expect(attached.body.data.reused[0].id).toBe(accountId);
  });

  it("flags a doctor who is already at this practice", async () => {
    const first = rid("Already");
    const last = rid("Here");
    const created = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
    );
    const accountId = created.body.data.created[0].id;

    const res = await preview(practiceAId, [
      { firstName: first, lastName: last },
    ]);
    expect(res.body.data.matches[0].userId).toBe(accountId);
    expect(res.body.data.matches[0].alreadyMemberOfPractice).toBe(true);
  });

  it("previews against the parent lab, for a practice that does not exist yet", async () => {
    const first = rid("Lab");
    const last = rid("Scoped");
    const created = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
    );
    const accountId = created.body.data.created[0].id;

    // The "add practice" dialog has no practice id yet — only the lab.
    const res = await preview(labOrgId, [{ firstName: first, lastName: last }]);
    expect(res.status).toBe(200);
    expect(res.body.data.matches[0].userId).toBe(accountId);
    expect(res.body.data.matches[0].alreadyMemberOfPractice).toBe(false);
  });

  it("keeps per-row indexes aligned and ignores rows with nothing typed yet", async () => {
    const first = rid("Indexed");
    const last = rid("Doctor");
    const created = track(
      await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
    );
    const accountId = created.body.data.created[0].id;

    const res = await preview(practiceAId, [
      {},
      { firstName: rid("Unknown"), lastName: rid("Person") },
      { firstName: first, lastName: last },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.matches.length).toBe(1);
    expect(res.body.data.matches[0].index).toBe(2);
    expect(res.body.data.matches[0].userId).toBe(accountId);
  });

  it("only another lab's admin is refused, and never sees the lab's doctors", async () => {
    const res = await preview(
      practiceAId,
      [{ firstName: "Anyone", lastName: "Atall" }],
      outsiderToken
    );
    expect(res.status).toBe(403);
  });

  describe("confirming a genuinely different person", () => {
    it("creates a separate account only for the match the admin dismissed", async () => {
      const first = rid("Same");
      const last = rid("Name");

      const created = track(
        await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
      );
      const firstAccountId = created.body.data.created[0].id;
      const firstNumber = created.body.data.created[0].platformAccountNumber;

      // Without the dismissal, this is the same person.
      const warned = await preview(practiceBId, [
        { firstName: first, lastName: last },
      ]);
      expect(warned.body.data.matches[0].userId).toBe(firstAccountId);

      // The admin says it's a different person with the same name.
      const second = track(
        await addDoctors(practiceBId, [
          {
            firstName: first,
            lastName: last,
            distinctFromUserIds: [firstAccountId],
          },
        ])
      );
      expect(second.status).toBe(201);
      expect(second.body.data.reused.length).toBe(0);
      expect(second.body.data.created.length).toBe(1);
      const secondAccountId = second.body.data.created[0].id;
      expect(secondAccountId).not.toBe(firstAccountId);
      expect(second.body.data.created[0].platformAccountNumber).not.toBe(
        firstNumber
      );

      // The decision is traceable back to the account that was dismissed.
      const { db, auditLogs } = dbMod as any;
      const logs = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, secondAccountId));
      const createdLog = logs.find(
        (l: any) => l.action === "practice_doctor_added"
      );
      expect(createdLog?.afterJson?.confirmedDistinctFromUserIds).toEqual([
        firstAccountId,
      ]);

      // Dismissing only the FIRST account still matches the second one — the
      // admin vouched for one account, not for "never reuse anything".
      const stillWarned = await preview(practiceAId, [
        {
          firstName: first,
          lastName: last,
          distinctFromUserIds: [firstAccountId],
        },
      ]);
      expect(stillWarned.body.data.matches[0].userId).toBe(secondAccountId);

      const reattached = track(
        await addDoctors(practiceAId, [
          {
            firstName: first,
            lastName: last,
            distinctFromUserIds: [firstAccountId],
          },
        ])
      );
      expect(reattached.body.data.created.length).toBe(0);
      expect(reattached.body.data.reused[0].id).toBe(secondAccountId);
    });

    it("still refuses to duplicate an email a dismissed account already owns", async () => {
      const first = rid("Shared");
      const last = rid("Inbox");
      const email = `${first}@example.test`.toLowerCase();

      const created = track(
        await addDoctors(practiceAId, [
          { firstName: first, lastName: last, email },
        ])
      );
      const accountId = created.body.data.created[0].id;

      // A human can override a name collision; a shared mailbox is not a
      // judgement call, so the row is refused instead of duplicated.
      const forced = track(
        await addDoctors(practiceBId, [
          {
            firstName: rid("Different"),
            lastName: rid("Person"),
            email,
            distinctFromUserIds: [accountId],
          },
        ])
      );
      expect(forced.status).toBe(201);
      expect(forced.body.data.created.length).toBe(0);
      expect(forced.body.data.reused.length).toBe(0);
      expect(forced.body.data.skipped.length).toBe(1);
      expect(forced.body.data.skipped[0].reason).toMatch(/email already exists/i);
    });

    it("refuses the row when the dismissed account owns the typed email and another account matches the name", async () => {
      // The nastiest shape of this: account A owns the email and is dismissed
      // as "a different person", while account B independently matches on
      // name. Attaching B would bind A's address to the wrong person, so the
      // row must be refused rather than resolved down to B.
      const shared = rid("Shared");
      const nameToken = rid("Twin");
      const email = `${shared}@example.test`.toLowerCase();

      const ownerRes = track(
        await addDoctors(practiceAId, [
          { firstName: nameToken, lastName: shared, email },
        ])
      );
      const ownerId = ownerRes.body.data.created[0].id;

      // A second, genuinely different account that shares the first name.
      const twinRes = track(
        await addDoctors(practiceBId, [
          {
            firstName: nameToken,
            lastName: shared,
            distinctFromUserIds: [ownerId],
          },
        ])
      );
      const twinId = twinRes.body.data.created[0].id;
      expect(twinId).not.toBe(ownerId);

      // With the email owner dismissed, the resolver's best remaining answer
      // is the twin — but the email is not the admin's to reassign.
      const blocked = track(
        await addDoctors(practiceAId, [
          {
            firstName: nameToken,
            lastName: shared,
            email,
            distinctFromUserIds: [ownerId],
          },
        ])
      );
      expect(blocked.body.data.created.length).toBe(0);
      expect(blocked.body.data.reused.length).toBe(0);
      expect(blocked.body.data.skipped[0].reason).toMatch(
        /email already exists/i
      );

      // ...and the warning said so before submit, instead of promising the
      // twin's account.
      const warned = await preview(practiceAId, [
        {
          firstName: nameToken,
          lastName: shared,
          email,
          distinctFromUserIds: [ownerId],
        },
      ]);
      expect(warned.body.data.emailConflicts).toEqual([0]);
      expect(warned.body.data.matches).toEqual([]);

      // Without the email, the twin is matched normally.
      const unblocked = await preview(practiceAId, [
        {
          firstName: nameToken,
          lastName: shared,
          distinctFromUserIds: [ownerId],
        },
      ]);
      expect(unblocked.body.data.matches[0].userId).toBe(twinId);
      expect(unblocked.body.data.emailConflicts).toEqual([]);
    });

    it("an unrelated dismissal does not stop the usual reuse", async () => {
      const first = rid("Untouched");
      const last = rid("Reuse");
      const created = track(
        await addDoctors(practiceAId, [{ firstName: first, lastName: last }])
      );
      const accountId = created.body.data.created[0].id;

      const again = track(
        await addDoctors(practiceBId, [
          {
            firstName: first,
            lastName: last,
            distinctFromUserIds: [rid("someone-else")],
          },
        ])
      );
      expect(again.body.data.created.length).toBe(0);
      expect(again.body.data.reused[0].id).toBe(accountId);
    });
  });
});
