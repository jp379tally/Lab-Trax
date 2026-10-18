import { useState, useEffect } from "react";
import { apiFetch, getProviderOrganizationId } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { toast } from "@/hooks/use-toast";
import { ProviderAutoPayAuthorization } from "@/components/autopay/AutoPayAuthorization";
import type {
  SharedProviderAccountChange,
  SharedProviderAccountData,
  SharedProviderContactChanges,
} from "@workspace/api-client-react";

interface ProfileData {
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

// /auth/me returns { success, user, memberships } directly (not wrapped in
// the standard { ok, data } envelope), so we type the full response shape.
interface MeResponse {
  success: boolean;
  user: ProfileData;
  memberships: unknown[];
}

interface BillingPreferences {
  subscription: { enabled: boolean; chargeDay: number };
  labs: Array<{
    providerOrganizationId: string;
    labOrganizationId: string;
    labName: string | null;
    providerName: string;
    enabled: boolean;
    chargeDay: number;
  }>;
}

type SharedAccountDraft = {
  name: string;
  displayName: string;
  billingEmail: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
};

export function ProviderMyAccount({ providerAutopayRequest, providerAutopayToken }: {
  providerAutopayRequest?: string;
  providerAutopayToken?: string;
} = {}) {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    practiceName: "",
    practiceAddress: "",
    practicePhone: "",
  });
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [billingPreferences, setBillingPreferences] =
    useState<BillingPreferences | null>(null);
  const [sharedAccounts, setSharedAccounts] = useState<
    Record<string, SharedProviderAccountData>
  >({});
  const [accountDrafts, setAccountDrafts] = useState<
    Record<string, SharedAccountDraft>
  >({});
  const [accountSaving, setAccountSaving] = useState<string | null>(null);
  const [requestSaving, setRequestSaving] = useState<string | null>(null);
  const [subscriptionSaving, setSubscriptionSaving] = useState(false);
  const [cardSetupLoading, setCardSetupLoading] = useState<string | null>(null);
  const [billingNotice, setBillingNotice] = useState<{
    tone: "success" | "warning" | "danger";
    message: string;
  } | null>(null);

  async function refreshBillingControls() {
    if (!getProviderOrganizationId()) {
      setBillingNotice({ tone: "warning", message: "Your profile is available. Practice billing requires an active, approved practice. Return to Dashboard to select a practice or refresh access after approval." });
      return;
    }
    setBillingNotice(null);
    const preferenceData = await apiFetch<BillingPreferences>(
      "/provider/billing-preferences",
    );
    const selectedId = getProviderOrganizationId();
    const scopedPreferences = selectedId
      ? { ...preferenceData, labs: (preferenceData.labs ?? []).filter((lab) => lab.providerOrganizationId === selectedId) }
      : preferenceData;
    setBillingPreferences(scopedPreferences);
    const accountEntries = await Promise.all(
      (scopedPreferences.labs ?? []).map(async (lab) => {
        const account = await apiFetch<SharedProviderAccountData>(
          `/organizations/shared-accounts?labOrganizationId=${encodeURIComponent(lab.labOrganizationId)}&providerOrganizationId=${encodeURIComponent(lab.providerOrganizationId)}`,
        );
        return [lab.providerOrganizationId, account] as const;
      }),
    );
    const nextAccounts = Object.fromEntries(accountEntries);
    setSharedAccounts(nextAccounts);
    setAccountDrafts(
      Object.fromEntries(
        accountEntries.map(([providerOrganizationId, account]) => [
          providerOrganizationId,
          {
            name: account.contact.name ?? "",
            displayName: account.contact.displayName ?? "",
            billingEmail: account.contact.billingEmail ?? "",
            phone: account.contact.phone ?? "",
            addressLine1: account.contact.addressLine1 ?? "",
            addressLine2: account.contact.addressLine2 ?? "",
            city: account.contact.city ?? "",
            state: account.contact.state ?? "",
            zip: account.contact.zip ?? "",
          },
        ]),
      ),
    );
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // /auth/me uses res.json directly (not ok()), so apiFetch returns the
        // full { success, user, memberships } object without unwrapping.
        const resp = await apiFetch<MeResponse>("/auth/me");
        const data: ProfileData = resp.user;
        if (!cancelled) {
          setProfile(data);
          setForm({
            firstName: data.firstName ?? "",
            lastName: data.lastName ?? "",
            email: data.email ?? "",
            phone: data.phone ?? "",
            practiceName: data.practiceName ?? "",
            practiceAddress: data.practiceAddress ?? "",
            practicePhone: data.practicePhone ?? "",
          });
        }
        await refreshBillingControls().catch(() => {
          if (!cancelled) {
            setBillingNotice({
              tone: "danger",
              message: "Billing controls could not be loaded. Your profile is still available.",
            });
          }
        });

        const params = new URLSearchParams(window.location.search);
        const setupSession = params.get("providerCardSetupSession");
        if (!setupSession || cancelled) return;
        if (params.get("cancelled") === "1") {
          setBillingNotice({
            tone: "warning",
            message: "Card setup was cancelled. No card was changed.",
          });
        } else {
          const result = await apiFetch<{
            status: "pending" | "succeeded" | "expired";
          }>(
            `/provider/payment-method/setup-status/${encodeURIComponent(setupSession)}`,
          );
          if (cancelled) return;
          if (result.status === "succeeded") {
            await refreshBillingControls();
            setBillingNotice({
              tone: "success",
              message: "Your shared card was updated securely.",
            });
          } else if (result.status === "expired") {
            setBillingNotice({
              tone: "danger",
              message: "That card setup session expired. Please start again.",
            });
          } else {
            setBillingNotice({
              tone: "warning",
              message: "Stripe is still confirming the card. Refresh this page in a moment.",
            });
          }
        }
        params.delete("providerCardSetupSession");
        params.delete("providerOrganizationId");
        params.delete("cancelled");
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`,
        );
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error ? e.message : "Failed to load profile."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function startCardSetup(providerOrganizationId: string) {
    if (cardSetupLoading) return;
    setCardSetupLoading(providerOrganizationId);
    setBillingNotice(null);
    try {
      const result = await apiFetch<{ url: string | null }>(
        "/provider/payment-method/setup-checkout",
        {
          method: "POST",
          body: JSON.stringify({ providerOrganizationId }),
        },
      );
      if (!result.url) throw new Error("Stripe did not return a card setup link.");
      window.location.assign(result.url);
    } catch (error) {
      setBillingNotice({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "Could not open secure card setup.",
      });
      setCardSetupLoading(null);
    }
  }

  async function requestAccountUpdate(providerOrganizationId: string) {
    const account = sharedAccounts[providerOrganizationId];
    const draft = accountDrafts[providerOrganizationId];
    if (!account || !draft || accountSaving) return;
    const changes: SharedProviderContactChanges = {};
    for (const field of [
      "name",
      "displayName",
      "billingEmail",
      "phone",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "zip",
    ] as const) {
      const next = draft[field].trim() || null;
      if (next === account.contact[field]) continue;
      if (field === "name") {
        if (!next) {
          setBillingNotice({
            tone: "warning",
            message: "Legal practice name cannot be blank.",
          });
          return;
        }
        changes.name = next;
      } else {
        changes[field] = next;
      }
    }
    if (Object.keys(changes).length === 0) {
      setBillingNotice({
        tone: "warning",
        message: "No contact changes to save.",
      });
      return;
    }
    setAccountSaving(providerOrganizationId);
    setBillingNotice(null);
    try {
      await apiFetch("/organizations/provider-portal-contact", {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      await refreshBillingControls();
      setBillingNotice({
        tone: "success",
        message: "Practice contact details were updated.",
      });
    } catch (error) {
      setBillingNotice({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "Could not update the practice contact details.",
      });
    } finally {
      setAccountSaving(null);
    }
  }

  async function decideAccountRequest(
    request: SharedProviderAccountChange,
    decision: "approve" | "reject",
  ) {
    if (requestSaving) return;
    setRequestSaving(request.id);
    setBillingNotice(null);
    try {
      await apiFetch(
        `/organizations/shared-accounts/profile-change-requests/${encodeURIComponent(request.id)}/${decision}`,
        { method: "POST" },
      );
      await refreshBillingControls();
      setBillingNotice({
        tone: "success",
        message:
          decision === "approve"
            ? "The lab's contact update was approved."
            : "The lab's contact update was declined.",
      });
    } catch (error) {
      await refreshBillingControls().catch(() => undefined);
      setBillingNotice({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "Could not review that contact update.",
      });
    } finally {
      setRequestSaving(null);
    }
  }

  async function saveSubscriptionPreference() {
    if (!billingPreferences || subscriptionSaving) return;
    const { enabled, chargeDay } = billingPreferences.subscription;
    if (!Number.isInteger(chargeDay) || chargeDay < 1 || chargeDay > 10) {
      setBillingNotice({
        tone: "danger",
        message: "Subscription charge day must be from 1 through 10.",
      });
      return;
    }
    setSubscriptionSaving(true);
    setBillingNotice(null);
    try {
      const result = await apiFetch<{
        subscription: { enabled: boolean; chargeDay: number };
      }>("/provider/subscription-autopay", {
        method: "PATCH",
        body: JSON.stringify({ enabled, chargeDay }),
      });
      setBillingPreferences((current) =>
        current ? { ...current, subscription: result.subscription } : current,
      );
      setBillingNotice({
        tone: "success",
        message: "Subscription auto-pay preference saved.",
      });
    } catch (error) {
      setBillingNotice({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "Could not save subscription auto-pay.",
      });
    } finally {
      setSubscriptionSaving(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setSaving(true);
    try {
      await apiFetch(`/auth/users/${profile.id}/profile`, {
        method: "PUT",
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          phone: form.phone,
          practiceName: form.practiceName,
          practiceAddress: form.practiceAddress,
          practicePhone: form.practicePhone,
        }),
      });
      toast({
        title: "Profile updated",
        description: "Your changes have been saved.",
      });
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Could not save changes.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  const accountNumber =
    profile?.practiceAccountNumber ?? user?.practiceAccountNumber ?? null;

  if (loadError) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm"
      >
        {loadError}
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="text-sm text-muted-foreground">Loading profile…</div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div className="mb-6">
        <h2 className="text-base font-semibold">My Account</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Update your contact information and practice details.
        </p>
      </div>

      {billingNotice && (
        <div
          role="status"
          className={`rounded-md border px-4 py-3 text-sm ${
            billingNotice.tone === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : billingNotice.tone === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {billingNotice.message}
        </div>
      )}

      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Shared lab accounts</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Each lab relationship has its own approved contact profile and
            billing settings. Card details come directly from Stripe; LabTrax
            never stores or displays the full card number.
          </p>
        </div>
        {billingPreferences ? (
          <div className="space-y-3">
            {billingPreferences.labs.map((lab) => {
              const account = sharedAccounts[lab.providerOrganizationId];
              const card = account?.card ?? null;
              const draft = accountDrafts[lab.providerOrganizationId];
              const requests = account?.profileChangeRequests ?? [];
              return (
                <div
                  key={lab.providerOrganizationId}
                  className="space-y-4 rounded-md border border-border px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold">
                        {lab.labName ?? "Linked lab"}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {card
                          ? `${card.brand.toUpperCase()} •••• ${card.last4}`
                          : "No shared card on file"}
                        {card
                          ? ` · Expires ${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`
                          : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={Boolean(cardSetupLoading)}
                      onClick={() =>
                        void startCardSetup(lab.providerOrganizationId)
                      }
                      className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {cardSetupLoading === lab.providerOrganizationId
                        ? "Opening…"
                        : card
                          ? "Replace card"
                          : "Add card"}
                    </button>
                  </div>

                  {draft && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {([
                        ["name", "Legal practice name"],
                        ["displayName", "Practice display name"],
                        ["billingEmail", "Billing email"],
                        ["phone", "Practice phone"],
                        ["addressLine1", "Address"],
                        ["city", "City"],
                        ["state", "State"],
                        ["zip", "ZIP"],
                      ] as const).map(([field, label]) => (
                        <label key={field} className="text-xs">
                          <span className="mb-1 block font-medium">{label}</span>
                          <input
                            aria-label={`${label} for ${lab.labName ?? "linked lab"}`}
                            type={field === "billingEmail" ? "email" : "text"}
                            value={draft[field]}
                            onChange={(event) =>
                              setAccountDrafts((current) => ({
                                ...current,
                                [lab.providerOrganizationId]: {
                                  ...current[lab.providerOrganizationId],
                                  [field]: event.target.value,
                                },
                              }))
                            }
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
                          />
                        </label>
                      ))}
                      <label className="text-xs sm:col-span-2">
                        <span className="mb-1 block font-medium">Address line 2</span>
                        <input
                          aria-label={`Address line 2 for ${lab.labName ?? "linked lab"}`}
                          value={draft.addressLine2}
                          onChange={(event) =>
                            setAccountDrafts((current) => ({
                              ...current,
                              [lab.providerOrganizationId]: {
                                ...current[lab.providerOrganizationId],
                                addressLine2: event.target.value,
                              },
                            }))
                          }
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
                        />
                      </label>
                      <div className="sm:col-span-2">
                        <button
                          type="button"
                          disabled={accountSaving !== null}
                          onClick={() =>
                            void requestAccountUpdate(lab.providerOrganizationId)
                          }
                          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        >
                          {accountSaving === lab.providerOrganizationId
                            ? "Sending…"
                            : "Request contact update"}
                        </button>
                      </div>
                    </div>
                  )}

                  {requests.length > 0 && (
                    <div className="space-y-2 border-t border-border pt-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Contact change history
                      </div>
                      {requests.map((request) => {
                        const fromLab =
                          request.requestedByOrganizationId ===
                          request.labOrganizationId;
                        return (
                          <div
                            key={request.id}
                            className="rounded-md bg-muted/50 px-3 py-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">
                                {fromLab ? "Lab proposed" : "You proposed"} ·{" "}
                                {request.status}
                              </span>
                              {fromLab && request.status === "pending" && (
                                <span className="flex gap-1">
                                  <button
                                    type="button"
                                    disabled={requestSaving !== null}
                                    onClick={() =>
                                      void decideAccountRequest(request, "approve")
                                    }
                                    className="rounded border border-border px-2 py-1 font-medium"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    disabled={requestSaving !== null}
                                    onClick={() =>
                                      void decideAccountRequest(request, "reject")
                                    }
                                    className="rounded border border-border px-2 py-1 font-medium"
                                  >
                                    Decline
                                  </button>
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {Object.entries(request.changes)
                                .map(([field, value]) => `${field}: ${value || "blank"}`)
                                .join(" · ")}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground space-y-2">
            <p>{billingNotice && billingNotice.tone !== "success" ? billingNotice.message :
              !getProviderOrganizationId() ? "Practice billing requires an active, approved practice." : "Loading billing details…"}</p>
            {getProviderOrganizationId() && billingNotice?.tone === "danger" && (
              <button type="button" className="underline" onClick={() => void refreshBillingControls().catch(() => {
                setBillingNotice({ tone: "danger", message: "Billing controls could not be loaded. Your profile is still available." });
              })}>Retry billing details</button>
            )}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Subscription auto-pay</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Choose whether LabTrax may charge your provider subscription
            automatically and select a charge day from 1 through 10.
          </p>
        </div>
        {billingPreferences && (
          <>
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="subscription-autopay" className="text-sm">
                Enable subscription auto-pay
              </label>
              <input
                id="subscription-autopay"
                type="checkbox"
                checked={billingPreferences.subscription.enabled}
                onChange={(event) =>
                  setBillingPreferences((current) =>
                    current
                      ? {
                          ...current,
                          subscription: {
                            ...current.subscription,
                            enabled: event.target.checked,
                          },
                        }
                      : current,
                  )
                }
                disabled={subscriptionSaving}
                className="h-4 w-4 accent-primary"
              />
            </div>
            <div>
              <label
                htmlFor="subscription-charge-day"
                className="block text-xs font-medium mb-1"
              >
                Charge day
              </label>
              <input
                id="subscription-charge-day"
                type="number"
                min={1}
                max={10}
                value={billingPreferences.subscription.chargeDay}
                onChange={(event) =>
                  setBillingPreferences((current) =>
                    current
                      ? {
                          ...current,
                          subscription: {
                            ...current.subscription,
                            chargeDay: Number(event.target.value),
                          },
                        }
                      : current,
                  )
                }
                disabled={subscriptionSaving}
                className="w-24 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Payments are due by the 10th. When enabled, the subscription
              charge is attempted on your selected day.
            </p>
            <button
              type="button"
              onClick={() => void saveSubscriptionPreference()}
              disabled={subscriptionSaving}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {subscriptionSaving ? "Saving…" : "Save subscription auto-pay"}
            </button>
          </>
        )}
      </section>

      <ProviderAutoPayAuthorization
        providerOrganizationId={getProviderOrganizationId() ?? undefined}
        billingEmail={profile.email}
        requestId={providerAutopayRequest}
        requestToken={providerAutopayToken}
      />

      {accountNumber && (
        <div>
          <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Account Number
          </label>
          <div className="inline-flex items-center px-3 py-1.5 rounded-md bg-muted border border-border text-sm font-mono text-muted-foreground select-all">
            {accountNumber}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            This number is assigned by your lab and cannot be changed.
          </p>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="firstName"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              First Name
            </label>
            <input
              id="firstName"
              type="text"
              value={form.firstName}
              onChange={(e) =>
                setForm((f) => ({ ...f, firstName: e.target.value }))
              }
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label
              htmlFor="lastName"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Last Name
            </label>
            <input
              id="lastName"
              type="text"
              value={form.lastName}
              onChange={(e) =>
                setForm((f) => ({ ...f, lastName: e.target.value }))
              }
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="practiceName"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            Practice Name
          </label>
          <input
            id="practiceName"
            type="text"
            value={form.practiceName}
            onChange={(e) =>
              setForm((f) => ({ ...f, practiceName: e.target.value }))
            }
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label
            htmlFor="practiceAddress"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            Practice Address
          </label>
          <input
            id="practiceAddress"
            type="text"
            value={form.practiceAddress}
            onChange={(e) =>
              setForm((f) => ({ ...f, practiceAddress: e.target.value }))
            }
            placeholder="Street, City, State, ZIP"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Email on File
            </label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label
              htmlFor="phone"
              className="block text-xs font-medium text-muted-foreground mb-1"
            >
              Phone Number
            </label>
            <input
              id="phone"
              type="tel"
              value={form.phone}
              onChange={(e) =>
                setForm((f) => ({ ...f, phone: e.target.value }))
              }
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="practicePhone"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            Practice Phone
          </label>
          <input
            id="practicePhone"
            type="tel"
            value={form.practicePhone}
            onChange={(e) =>
              setForm((f) => ({ ...f, practicePhone: e.target.value }))
            }
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
