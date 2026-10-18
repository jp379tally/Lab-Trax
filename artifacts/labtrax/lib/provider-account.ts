// Data layer for the provider portal's My Account section.
//
// Mirrors what the desktop ProviderMyAccount loads and writes, endpoint for
// endpoint:
//   GET   /auth/me                              — the provider's own details
//   PUT   /auth/users/:id/profile               — saving them
//   GET   /provider/billing-preferences         — linked labs + subscription
//   GET   /organizations/shared-accounts        — per-lab card and contact
//   PATCH /organizations/provider-portal-contact — the practice contact
//
// One thing worth stating plainly, because the desktop layout hides it: the
// contact fields shown under each lab all write the SAME provider organization
// row — the practice's portal contact that every linked lab reads. There is no
// per-lab contact record to edit. Mobile mirrors the behaviour and says so on
// screen instead of implying otherwise.
import { resilientFetch } from "@/lib/query-client";
import { providerRequest } from "@/lib/provider-api";
import type { AutoPayPreference } from "@/lib/provider-billing";
import {
  getSharedProviderAccount,
  type SharedProviderAccountChange,
  type SharedProviderCard,
  type SharedProviderContact,
  type SharedProviderContactChanges,
} from "@/lib/shared-provider-account";

// Practice-scoped: "provider-portal" is purged on a practice switch (see
// PRACTICE_SCOPED_QUERY_PREFIXES) so My Account cannot paint another
// practice's card or contact.
export const PROVIDER_ACCOUNT_QUERY_KEY = ["provider-portal", "account"] as const;

export function providerAccountQueryKey(providerOrganizationId: string | null) {
  return [...PROVIDER_ACCOUNT_QUERY_KEY, providerOrganizationId ?? "none"] as const;
}

// ── The provider's own details ─────────────────────────────────────────────

export interface ProviderAccountUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  practiceName?: string | null;
  practiceAddress?: string | null;
  practicePhone?: string | null;
  practiceAccountNumber?: string | null;
}

export interface ProviderProfileForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  practiceName: string;
  practiceAddress: string;
  practicePhone: string;
}

export const PROVIDER_PROFILE_FIELDS: ReadonlyArray<{
  key: keyof ProviderProfileForm;
  label: string;
  keyboardType?: "email-address" | "phone-pad";
  placeholder?: string;
}> = [
  { key: "firstName", label: "First Name" },
  { key: "lastName", label: "Last Name" },
  { key: "practiceName", label: "Practice Name" },
  {
    key: "practiceAddress",
    label: "Practice Address",
    placeholder: "Street, City, State, ZIP",
  },
  { key: "email", label: "Email on File", keyboardType: "email-address" },
  { key: "phone", label: "Phone Number", keyboardType: "phone-pad" },
  { key: "practicePhone", label: "Practice Phone", keyboardType: "phone-pad" },
];

export const EMPTY_PROVIDER_PROFILE_FORM: ProviderProfileForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  practiceName: "",
  practiceAddress: "",
  practicePhone: "",
};

/**
 * Read the profile out of a `/auth/me` body.
 *
 * `/auth/me` answers `{ success, user, memberships }` directly rather than the
 * `{ ok, data }` envelope, so the user object is read off the response as-is.
 */
export function providerAccountUserFrom(me: unknown): ProviderAccountUser | null {
  if (!me || typeof me !== "object") return null;
  const user = (me as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;
  const id = (user as { id?: unknown }).id;
  if (typeof id !== "string" || !id) return null;
  return user as ProviderAccountUser;
}

export function profileFormFrom(
  user: ProviderAccountUser | null | undefined,
): ProviderProfileForm {
  if (!user) return EMPTY_PROVIDER_PROFILE_FORM;
  return {
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    email: user.email ?? "",
    phone: user.phone ?? "",
    practiceName: user.practiceName ?? "",
    practiceAddress: user.practiceAddress ?? "",
    practicePhone: user.practicePhone ?? "",
  };
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    for (const key of ["message", "error"] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallback;
}

/** Persist the provider's own details. Throws with the server's message. */
export async function saveProviderProfile(
  userId: string,
  form: ProviderProfileForm,
): Promise<void> {
  const response = await resilientFetch(
    `/api/auth/users/${encodeURIComponent(userId)}/profile`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        practiceName: form.practiceName,
        practiceAddress: form.practiceAddress,
        practicePhone: form.practicePhone,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(messageFrom(body, "Could not save changes."));
  }
}

// ── Shared lab accounts ────────────────────────────────────────────────────

export const PROVIDER_CONTACT_FIELDS = [
  { key: "name", label: "Legal practice name" },
  { key: "displayName", label: "Practice display name" },
  { key: "billingEmail", label: "Billing email", keyboardType: "email-address" },
  { key: "phone", label: "Practice phone", keyboardType: "phone-pad" },
  { key: "addressLine1", label: "Address" },
  { key: "addressLine2", label: "Address line 2" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
] as const satisfies ReadonlyArray<{
  key: keyof SharedProviderContactChanges;
  label: string;
  keyboardType?: "email-address" | "phone-pad";
}>;

export type ProviderContactField = (typeof PROVIDER_CONTACT_FIELDS)[number]["key"];
export type ProviderContactDraft = Record<ProviderContactField, string>;

export const EMPTY_PROVIDER_CONTACT_DRAFT: ProviderContactDraft = {
  name: "",
  displayName: "",
  billingEmail: "",
  phone: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
};

export function contactDraftFrom(
  contact: SharedProviderContact | null | undefined,
): ProviderContactDraft {
  if (!contact) return EMPTY_PROVIDER_CONTACT_DRAFT;
  return {
    name: contact.name ?? "",
    displayName: contact.displayName ?? "",
    billingEmail: contact.billingEmail ?? "",
    phone: contact.phone ?? "",
    addressLine1: contact.addressLine1 ?? "",
    addressLine2: contact.addressLine2 ?? "",
    city: contact.city ?? "",
    state: contact.state ?? "",
    zip: contact.zip ?? "",
  };
}

export type ProviderContactDiff =
  | { ok: true; changes: SharedProviderContactChanges }
  | { ok: false; message: string };

/**
 * Which contact fields actually changed, with the desktop's two refusals:
 * the legal name may not be cleared, and an unchanged form is not a save.
 */
export function diffProviderContact(
  contact: SharedProviderContact | null | undefined,
  draft: ProviderContactDraft | null | undefined,
): ProviderContactDiff {
  if (!contact || !draft) {
    return { ok: false, message: "No contact changes to save." };
  }
  const changes: SharedProviderContactChanges = {};
  for (const field of PROVIDER_CONTACT_FIELDS) {
    const next = draft[field.key].trim() || null;
    if (next === (contact[field.key] ?? null)) continue;
    if (field.key === "name") {
      if (!next) return { ok: false, message: "Legal practice name cannot be blank." };
      changes.name = next;
      continue;
    }
    changes[field.key] = next;
  }
  if (Object.keys(changes).length === 0) {
    return { ok: false, message: "No contact changes to save." };
  }
  return { ok: true, changes };
}

/** Card line shown under a lab, matching desktop's wording exactly. */
export function describeSharedCard(card: SharedProviderCard | null | undefined): string {
  if (!card) return "No shared card on file";
  const expiry = `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`;
  return `${card.brand.toUpperCase()} •••• ${card.last4} · Expires ${expiry}`;
}

export interface ProviderAccountLab {
  providerOrganizationId: string;
  labOrganizationId: string | null;
  labName: string | null;
  providerName: string;
  card: SharedProviderCard | null;
  contact: SharedProviderContact | null;
  profileChangeRequests: SharedProviderAccountChange[];
}

export interface ProviderAccountBilling {
  subscription: AutoPayPreference;
  labs: ProviderAccountLab[];
}

interface BillingPreferencesResponse {
  subscription?: AutoPayPreference;
  labs?: Array<{
    providerOrganizationId: string;
    labOrganizationId: string | null;
    labName: string | null;
    providerName: string;
  }>;
}

/**
 * Linked labs (card + contact + change history) and the subscription
 * preference, scoped to the active practice the way desktop scopes it.
 */
export async function getProviderAccountBilling(
  providerOrganizationId: string | null,
): Promise<ProviderAccountBilling> {
  const preferences = await providerRequest<BillingPreferencesResponse>(
    "/api/provider/billing-preferences",
  );
  const labs = (preferences.labs ?? []).filter(
    (lab) =>
      !providerOrganizationId ||
      lab.providerOrganizationId === providerOrganizationId,
  );
  const entries = await Promise.all(
    labs.map(async (lab): Promise<ProviderAccountLab> => {
      const base = {
        providerOrganizationId: lab.providerOrganizationId,
        labOrganizationId: lab.labOrganizationId,
        labName: lab.labName,
        providerName: lab.providerName,
      };
      if (!lab.labOrganizationId) {
        return { ...base, card: null, contact: null, profileChangeRequests: [] };
      }
      const account = await getSharedProviderAccount(
        lab.labOrganizationId,
        lab.providerOrganizationId,
      );
      return {
        ...base,
        card: account.card ?? null,
        contact: account.contact ?? null,
        profileChangeRequests: account.profileChangeRequests ?? [],
      };
    }),
  );
  return {
    subscription: preferences.subscription ?? { enabled: false, chargeDay: 10 },
    labs: entries,
  };
}

/** Update the practice's portal contact (shared by every linked lab). */
export async function updateProviderPortalContact(
  changes: SharedProviderContactChanges,
): Promise<void> {
  await providerRequest("/api/organizations/provider-portal-contact", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
}
