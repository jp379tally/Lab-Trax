// Non-production fixtures around the real shell and dashboard. No API writes.
import React from "react";
import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import { AppLayout } from "@/components/AppLayout";
import DashboardPage from "@/pages/dashboard";
import { makeAuthWrapper } from "@/__tests__/test-utils";
import { UploadsProvider } from "@/lib/uploads-context";
import type { SessionUser } from "@/lib/api";
import type { LabCase } from "@/lib/types";
import "@/index.css";

const params = new URLSearchParams(window.location.search);
const today = new Date();
const day = (offset: number) => {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const user = {
  id: "reference-staff", username: "reference-staff", firstName: "Jordan",
  lastName: "Example", role: params.has("readonly") ? "user" : "admin",
  userType: "lab", practiceOrganizationId: "reference-lab",
  practiceName: "Reference Dental Laboratory",
} as SessionUser;
const cases = Array.from({ length: 16 }, (_, i) => ({
  id: `reference-case-${i}`, caseNumber: `26-${2400 + i}`,
  patientFirstName: "Sample", patientLastName: `Patient ${i + 1}`,
  doctorName: `Dr. Example ${i % 3 + 1}`,
  status: ["received", "in_design", "qc"][i % 3],
  priority: i === 1 ? "rush" : "normal",
  dueDate: i < 7 ? day(-1 - i) : i < 11 ? day(0) : i < 15 ? day(1) : null,
  expectedDeliveryDate: null, dueTime: null, currentLocationName: "Crown & Bridge",
  createdAt: today.toISOString(), updatedAt: today.toISOString(), receivedAt: day(0),
  restorationTypes: "crown", restorationMaterials: "zirconia", totalPrice: "100",
  restorations: [], notes: [], events: [], attachments: [],
  labOrganizationId: "reference-lab", viewerIsLabMember: true,
})) as unknown as LabCase[];
const organization = {
  id: "reference-lab", name: user.practiceName, displayName: user.practiceName,
  type: "lab", accountNumber: "REFERENCE1", isActive: true,
};
const requests: string[] = [];
Object.assign(window, { dashboardFixtureRequests: requests });
setBaseUrl(null);

function json(data: unknown, envelope = true, status = 200) {
  return new Response(JSON.stringify(envelope ? { ok: status < 400, data } : data), {
    status, headers: { "Content-Type": "application/json" },
  });
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
  const url = new URL(raw, window.location.origin);
  const path = url.pathname.replace(/^.*\/api/, "");
  requests.push(`${init?.method ?? "GET"} ${path}`);
  if (init?.method && init.method !== "GET") return json({ message: "Fixture is read-only" }, false, 403);
  if (params.has("profile-error") && path === "/auth/me") {
    return json({ message: "Fixture profile load failure" }, false, 500);
  }
  if (params.has("loading") && ["/cases", "/lab-inbox"].includes(path)) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  if (params.has("error") && ["/cases", "/cases/recent", "/lab-inbox"].includes(path)) {
    return json({ ok: false, message: "Fixture load failure" }, false, 500);
  }
  switch (path) {
    case "/auth/me": return json({
      user, memberships: [{ id: "reference-member", organizationId: organization.id,
        organization, status: "active", role: params.has("readonly") ? "user" : "admin" }],
    });
    case "/cases": return json(params.has("empty") ? [] : cases);
    case "/cases/recent": return json(params.has("empty") ? [] : cases.slice(0, 5));
    case "/case-exceptions/active": return json({ exceptions: params.has("empty") ? [] : [{
      id: "reference-exception", caseId: cases[0].id, caseNumber: cases[0].caseNumber,
      patientFirstName: "Sample", patientLastName: "Patient 1", doctorName: "Dr. Example 1",
      currentLocationName: "Crown & Bridge", caseStatus: "received",
      issueText: "Please confirm the shade before production.", createdAt: today.toISOString(),
    }] });
    case "/lab-inbox": return json(params.has("empty") ? [] : [{
      id: "reference-file", originalFilename: "Sample_Prescription.pdf", storagePath: "fixture",
      mimeType: "application/pdf", sizeBytes: 12800, createdAt: today.toISOString(),
      uploaderFirstName: "Jordan", uploaderLastName: "Example", note: "Confirm shade",
    }]);
    case "/billing/subscription": return json({ entitlement: { status: "active", accessLevel: "full" } });
    case "/creator/access": return json({ isCreator: false });
    case "/provider-messenger/unread-count": return json({ total: 0 });
    case "/doctors/duplicate-clusters": return json({ totalGroups: 0, clusters: [] });
    case "/legacy/cases": return json({ cases: [] });
    case "/organizations": return json([organization]);
    case "/locations": return json([{ id: "reference-location", name: "Crown & Bridge", code: "CB", status: "received" }]);
    case "/invoices/reports/sales": return json({ totalSales: "1520.00", invoices: 7 });
    case "/notifications":
    case "/vocabulary":
    case "/cases/doctor-names":
    case "/cases/doctor-directory": return json([]);
    case "/auth/lab-team": return json({ pendingJoinRequests: [] });
    case "/admin/backup/overdue-status": return json({
      stale: false, overdue: false, lastSuccessfulBackupAt: today.toISOString(),
    });
    default:
      if (path.includes("backup") && path.includes("fresh")) {
        return json({ stale: false, lastSuccessfulBackupAt: today.toISOString() });
      }
      if (path.includes("customer-requests")) return json([]);
      console.error(`Unmapped dashboard fixture request: ${path}`);
      return json({ ok: false, message: `Unmapped fixture ${path}` }, false, 404);
  }
}) as typeof fetch;

const Wrapper = makeAuthWrapper("/", { user, status: "authed", restoreStatus: "ok" });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Wrapper>
      <UploadsProvider>
        <AppLayout><DashboardPage /></AppLayout>
      </UploadsProvider>
    </Wrapper>
  </React.StrictMode>,
);
