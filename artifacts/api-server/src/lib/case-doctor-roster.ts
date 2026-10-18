import { createHash } from "node:crypto";
import { and, eq, ilike, isNull } from "drizzle-orm";
import {
  db, cases, doctorProfiles, labCases, labUnassignedDoctors,
  organizationMemberships, pricingOverrides, users,
} from "@workspace/db";
import type { z } from "zod";
import type { GetCaseDoctorCandidates200Response } from "@workspace/api-zod";
import { normalizeDoctorForCompare } from "./doctor-similarity";

export type CaseDoctorTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type CaseDoctorCandidate = z.infer<typeof GetCaseDoctorCandidates200Response>["data"]["entries"][number];

export function parseCaseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read-only roster, not the duplicate matcher. An account must have an active
 * membership at THIS practice; a shared name never establishes affiliation.
 * Name-only sources are scoped before union/filter/pagination. No resolver or
 * account-number allocator is involved.
 */
export async function loadCaseDoctorRoster(
  tx: CaseDoctorTransaction,
  labId: string,
  practiceId: string,
): Promise<CaseDoctorCandidate[]> {
  // A transaction owns one client; do not enqueue parallel pg queries on it.
  const members = await tx.select({
      userId: users.id, username: users.username, firstName: users.firstName,
      lastName: users.lastName, doctorName: users.doctorName,
      userType: users.userType, isActive: users.isActive, userDeletedAt: users.deletedAt,
      platformAccountNumber: users.platformAccountNumber,
      status: organizationMemberships.status, deletedAt: organizationMemberships.deletedAt,
    }).from(organizationMemberships).innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(eq(organizationMemberships.labId, practiceId)).for("share");
  const removed = await tx.select({
      userId: labUnassignedDoctors.userId, name: labUnassignedDoctors.doctorName,
      removedFromOrganizationId: labUnassignedDoctors.removedFromOrganizationId,
      firstName: users.firstName, lastName: users.lastName,
      doctorName: users.doctorName, username: users.username,
    }).from(labUnassignedDoctors).leftJoin(users, eq(users.id, labUnassignedDoctors.userId))
      .where(and(eq(labUnassignedDoctors.labOrganizationId, labId), isNull(labUnassignedDoctors.deletedAt)));
  const history = await tx.selectDistinct({ name: cases.doctorName }).from(cases).where(and(
      eq(cases.labOrganizationId, labId), eq(cases.providerOrganizationId, practiceId), isNull(cases.deletedAt),
    ));
  const overrides = await tx.selectDistinct({ name: pricingOverrides.doctorName }).from(pricingOverrides).where(and(
      eq(pricingOverrides.labOrganizationId, labId), eq(pricingOverrides.providerOrganizationId, practiceId),
      isNull(pricingOverrides.deletedAt),
    ));
  const profiles = await tx.selectDistinct({ name: doctorProfiles.doctorName }).from(doctorProfiles).where(and(
      eq(doctorProfiles.labOrganizationId, labId), eq(doctorProfiles.providerOrganizationId, practiceId),
    ));
    // Cheap prefilter only; parsed explicit practice identity is authoritative.
  const legacy = await tx.select({ caseData: labCases.caseData }).from(labCases).where(and(
      eq(labCases.organizationId, labId), isNull(labCases.deletedAt),
      ilike(labCases.caseData, `%${practiceId.replace(/[\\%_]/g, "\\$&")}%`),
    ));
  const excludedIds = new Set(removed.flatMap((r) => r.userId ? [r.userId] : []));
  const excludedNames = new Set<string>();
  const addExcludedName = (name: string | null) => {
    if (name?.trim()) excludedNames.add(normalizeDoctorForCompare(name));
  };
  for (const r of removed) {
    // A name is not an account identity: a removal at another practice cannot
    // exclude an independently recorded name-only doctor at this practice.
    if (r.removedFromOrganizationId !== practiceId) continue;
    [r.name, r.doctorName, r.username, [r.firstName, r.lastName].filter(Boolean).join(" ")].forEach(addExcludedName);
  }
  const registered = new Map<string, CaseDoctorCandidate>();
  const registeredNames = new Set<string>();
  for (const m of members) {
    const name = [m.firstName, m.lastName].filter(Boolean).join(" ").trim() || m.doctorName?.trim() || m.username;
    if (m.userType !== "provider" || !m.isActive || m.userDeletedAt ||
        m.status !== "active" || m.deletedAt || excludedIds.has(m.userId)) {
      // Never resurrect inactive/retired/removed accounts through their history.
      [name, m.doctorName, m.username].forEach(addExcludedName);
      continue;
    }
    if (!name) continue;
    for (const alias of [name, m.doctorName, m.username]) {
      if (alias?.trim()) registeredNames.add(normalizeDoctorForCompare(alias));
    }
    registered.set(m.userId, {
      key: `user:${m.userId}`, doctorName: name, userId: m.userId,
      platformAccountNumber: m.platformAccountNumber,
    });
  }
  const nameOnly = new Map<string, CaseDoctorCandidate>();
  const legacyNames = legacy.flatMap((row) => {
    const parsed = parseCaseObject(row.caseData);
    return parsed?.providerOrganizationId === practiceId && typeof parsed.doctorName === "string"
      ? [{ name: parsed.doctorName }] : [];
  });
  // Deterministic representative spelling, including across search pages.
  const names = [...history, ...overrides, ...profiles, ...legacyNames]
    .map((r) => r.name?.trim() ?? "").filter(Boolean).sort();
  for (const name of names) {
    const normalized = normalizeDoctorForCompare(name);
    if (!normalized || registeredNames.has(normalized) || excludedNames.has(normalized) || nameOnly.has(normalized)) continue;
    nameOnly.set(normalized, {
      key: `name:${createHash("sha256").update(JSON.stringify([labId, practiceId, normalized])).digest("hex")}`,
      doctorName: name, userId: null, platformAccountNumber: null,
    });
  }
  return [...registered.values(), ...nameOnly.values()].sort((a, b) =>
    a.doctorName.localeCompare(b.doctorName) || a.key.localeCompare(b.key),
  );
}
