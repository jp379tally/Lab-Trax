// Real wizard with isolated read-only fixtures; never contacts a live lab.
import React from "react";
import { createRoot } from "react-dom/client";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "@/__tests__/test-utils";
import "@/index.css";

Object.assign(window, { electron: undefined });
localStorage.setItem("labtrax_finance_org_v1", "browser-lab");
const recipient = {
  key: "browser-practice", name: "Browser Practice", email: "test@example.invalid",
  phone: null, statementEmailOptOut: false, invoiceCount: 1, openBalance: 100,
  totalBilled: 100, doctors: [],
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method && init.method !== "GET") throw new Error("Browser fixture forbids writes");
  const path = new URL(String(input), location.origin).pathname;
  let data: unknown = {};
  if (path.endsWith("/organizations")) data = [{ id: "browser-lab", name: "Browser Lab", type: "lab" }];
  if (path.endsWith("/statement-runs")) data = [];
  if (path.endsWith("/statements/recipients")) data = { recipients: [recipient] };
  if (path.endsWith("/statements/account-summaries")) data = [{
    practiceId: recipient.key, practiceName: recipient.name, billingEmail: recipient.email,
    phone: null, openInvoiceCount: 1, openInvoiceTotal: 100, unpaidStatements: [],
    totalOpenBalance: 100, overdueBalance: 0, invoiceCount: 1, totalBilled: 100, totalPaid: 0,
  }];
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const Wrapper = makeAuthWrapper("/statements", {
  user: { id: "browser-user", username: "browser-admin", role: "admin", userType: "lab" } as any,
  status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true,
});
createRoot(document.getElementById("root")!).render(<Wrapper><StatementsPage /></Wrapper>);
