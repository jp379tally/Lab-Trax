import React from "react";
import { createRoot } from "react-dom/client";
import RegisterPage from "@/pages/finance/register";
import { makeAuthWrapper } from "@/__tests__/test-utils";
import type { SessionUser } from "@/lib/api";
import "@/index.css";

const organizationId = "browser-org";
const accountId = "browser-checking";

const user: SessionUser = {
  id: "browser-user",
  username: "browser-admin",
  role: "admin",
  userType: "lab",
};

const account = {
  id: accountId,
  organizationId,
  name: "Browser Test Checking",
  accountType: "checking",
  institution: null,
  last4: "4243",
  openingBalance: "0",
  bookBalance: "-800",
  clearedBalance: "0",
  unreconciledBalance: "-800",
  isArchived: false,
};

const transactions = Array.from({ length: 80 }, (_, index) => ({
  id: `browser-txn-${index}`,
  bankAccountId: accountId,
  txnDate: "2026-09-16T00:00:00.000Z",
  type: "other",
  checkNumber: String(1000 + index),
  payee: `Overflow transaction ${index + 1}`,
  memo: null,
  categoryId: null,
  debitAmount: "10",
  creditAmount: "0",
  runningBalance: String(-(index + 1) * 10),
  cleared: false,
  reconciled: false,
  status: "posted",
  source: "manual",
  invoices: [],
  transferGroupId: null,
  vendorId: null,
}));

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const browserState = globalThis as typeof globalThis & {
  __registerSavePayload?: Record<string, unknown>;
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/organizations")) {
    return json([{ id: organizationId, name: "Browser Test Lab", type: "lab" }]);
  }
  if (url.includes("/api/finance/accounts")) return json([account]);
  if (url.includes("/api/finance/categories")) return json([]);
  if (url.includes("/api/finance/vendors")) return json([]);
  if (url.includes("/api/finance/undeposited-funds")) {
    return json({ count: 0, total: 0 });
  }
  if (url.includes("/api/finance/transactions") && init?.method === "POST") {
    browserState.__registerSavePayload = JSON.parse(String(init.body));
    return json({ id: "browser-created-transaction" });
  }
  if (url.includes("/api/finance/transactions")) return json(transactions);
  return json({});
}) as typeof fetch;

const Wrapper = makeAuthWrapper("/finance/register", {
  user,
  status: "authed",
  restoreStatus: "ok",
  restoreNoticeDismissed: true,
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Wrapper>
      <RegisterPage />
    </Wrapper>
  </React.StrictMode>,
);