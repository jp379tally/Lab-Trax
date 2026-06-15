import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { apiFetch, ApiError } from "@/lib/api";
import { Logo } from "@/components/Logo";
import LoginPage from "@/pages/login";

interface InvitePreview {
  status: string;
  email: string | null;
  roleToAssign: string | null;
  organizationName: string;
  inviterName: string | null;
  expiresAt: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  user: "Team member",
  member: "Team member",
  billing: "Billing",
  read_only: "Read-only",
};

function roleLabel(role: string | null): string {
  if (!role) return "Team member";
  return ROLE_LABELS[role] ?? role.replace(/_/g, " ");
}

function formatExpiry(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const TERMINAL_COPY: Record<string, { title: string; body: string }> = {
  accepted: {
    title: "Invitation already accepted",
    body: "This invitation has already been accepted. You can continue to LabTrax.",
  },
  declined: {
    title: "Invitation declined",
    body: "This invitation was declined. If this was a mistake, ask the lab to send a new invite.",
  },
  expired: {
    title: "Invitation expired",
    body: "This invitation has expired. Ask the lab to send you a new one.",
  },
  revoked: {
    title: "Invitation no longer available",
    body: "This invitation was revoked by the lab. Ask them to send you a new one if you still need access.",
  },
};

export default function AcceptInvitePage({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const { status, user, refresh, logout } = useAuth();
  const [action, setAction] = useState<null | "accept" | "decline">(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<null | "accepted" | "declined">(null);
  const [error, setError] = useState<string | null>(null);

  const previewQuery = useQuery<InvitePreview>({
    queryKey: ["invite-preview", token],
    queryFn: () =>
      apiFetch<InvitePreview>(
        `/organizations/invite-preview/${encodeURIComponent(token)}`,
      ),
    retry: false,
  });

  const preview = previewQuery.data;
  const expiry = formatExpiry(preview?.expiresAt ?? null);

  async function submit(kind: "accept" | "decline") {
    setSubmitting(true);
    setAction(kind);
    setError(null);
    try {
      await apiFetch(
        `/organizations/invites/${encodeURIComponent(token)}/${kind}`,
        { method: "POST" },
      );
      setResult(kind === "accept" ? "accepted" : "declined");
      if (kind === "accept") {
        await refresh();
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : (err as Error)?.message || "Something went wrong. Please try again.";
      setError(message);
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  function Shell({ children }: { children: React.ReactNode }) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 px-4 py-10">
        <div className="w-full max-w-md rounded-xl border bg-card text-card-foreground shadow-sm p-8">
          <div className="flex justify-center mb-6">
            <Logo />
          </div>
          {children}
        </div>
      </div>
    );
  }

  // Loading the preview.
  if (previewQuery.isLoading) {
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">
          Loading invitation…
        </p>
      </Shell>
    );
  }

  // Preview failed to load (bad/unknown token).
  if (previewQuery.isError || !preview) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-center mb-2">
          Invitation not found
        </h1>
        <p className="text-center text-sm text-muted-foreground mb-6">
          This invitation link is invalid or no longer exists. Ask the lab to
          send you a new one.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium hover:opacity-90"
        >
          Continue to LabTrax
        </button>
      </Shell>
    );
  }

  // Action just completed in this session.
  if (result) {
    const accepted = result === "accepted";
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-center mb-2">
          {accepted ? "You're in!" : "Invitation declined"}
        </h1>
        <p className="text-center text-sm text-muted-foreground mb-6">
          {accepted
            ? `You now have access to ${preview.organizationName} as ${roleLabel(
                preview.roleToAssign,
              )}.`
            : `You declined the invitation to ${preview.organizationName}.`}
        </p>
        <button
          type="button"
          onClick={onDone}
          className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium hover:opacity-90"
        >
          Continue to LabTrax
        </button>
      </Shell>
    );
  }

  // Terminal status from the server (already accepted/declined/expired/revoked).
  if (preview.status !== "pending") {
    const copy = TERMINAL_COPY[preview.status] ?? {
      title: "Invitation unavailable",
      body: "This invitation is no longer available.",
    };
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-center mb-2">{copy.title}</h1>
        <p className="text-center text-sm text-muted-foreground mb-6">
          {copy.body}
        </p>
        <button
          type="button"
          onClick={onDone}
          className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium hover:opacity-90"
        >
          Continue to LabTrax
        </button>
      </Shell>
    );
  }

  const inviteDetails = (
    <div className="rounded-lg border bg-muted/40 px-4 py-3 mb-6 text-sm">
      <p className="mb-1">
        <span className="text-muted-foreground">Lab:</span>{" "}
        <span className="font-medium">{preview.organizationName}</span>
      </p>
      <p className="mb-1">
        <span className="text-muted-foreground">Role:</span>{" "}
        <span className="font-medium">{roleLabel(preview.roleToAssign)}</span>
      </p>
      {preview.inviterName && (
        <p className="mb-1">
          <span className="text-muted-foreground">Invited by:</span>{" "}
          <span className="font-medium">{preview.inviterName}</span>
        </p>
      )}
      {preview.email && (
        <p className="mb-1">
          <span className="text-muted-foreground">Invited email:</span>{" "}
          <span className="font-medium">{preview.email}</span>
        </p>
      )}
      {expiry && (
        <p className="text-xs text-muted-foreground mt-2">Expires {expiry}</p>
      )}
    </div>
  );

  // Anonymous — must sign in (or sign up) with the invited email first.
  if (status !== "authed") {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-center mb-2">
          You've been invited to {preview.organizationName}
        </h1>
        <p className="text-center text-sm text-muted-foreground mb-4">
          Sign in
          {preview.email ? (
            <>
              {" "}
              with <span className="font-medium">{preview.email}</span>
            </>
          ) : null}{" "}
          to accept or decline this invitation.
        </p>
        {inviteDetails}
        <div className="border-t pt-6">
          <LoginPage />
        </div>
      </Shell>
    );
  }

  // Authed — show accept/decline.
  return (
    <Shell>
      <h1 className="text-lg font-semibold text-center mb-2">
        You've been invited to {preview.organizationName}
      </h1>
      <p className="text-center text-sm text-muted-foreground mb-4">
        Review the details below, then accept or decline.
      </p>
      {inviteDetails}
      {error && (
        <p
          role="alert"
          className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2 mb-4"
        >
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit("accept")}
          className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium hover:opacity-90 disabled:opacity-60"
        >
          {submitting && action === "accept" ? "Accepting…" : "Accept invitation"}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit("decline")}
          className="w-full rounded-md border py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {submitting && action === "decline" ? "Declining…" : "Decline"}
        </button>
      </div>
      <div className="mt-6 text-center text-xs text-muted-foreground">
        Signed in as{" "}
        <span className="font-medium">{user?.email ?? user?.username}</span>.{" "}
        <button
          type="button"
          onClick={() => void logout()}
          className="underline hover:text-foreground"
        >
          Use a different account
        </button>
      </div>
    </Shell>
  );
}
