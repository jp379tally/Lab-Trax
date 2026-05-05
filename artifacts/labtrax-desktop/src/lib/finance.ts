import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api";
import type { BankAccount, Organization } from "./types";

const ORG_KEY = "labtrax_finance_org_v1";
const ACCT_KEY = "labtrax_finance_account_v1";

export function useLabOrganizations() {
  return useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const orgs = await apiFetch<Organization[]>("/organizations");
      return orgs.filter((o) => o.type === "lab");
    },
  });
}

export function useSelectedOrg(): [string | null, (id: string | null) => void] {
  const orgs = useLabOrganizations();
  const [selected, setSelected] = useState<string | null>(() =>
    localStorage.getItem(ORG_KEY)
  );
  useEffect(() => {
    if (!orgs.data?.length) return;
    if (!selected || !orgs.data.some((o) => o.id === selected)) {
      const first = orgs.data[0]!.id;
      setSelected(first);
      localStorage.setItem(ORG_KEY, first);
    }
  }, [orgs.data, selected]);
  function update(id: string | null) {
    setSelected(id);
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
  }
  return [selected, update];
}

export function useBankAccounts(organizationId: string | null) {
  return useQuery({
    queryKey: ["finance", "accounts", organizationId],
    queryFn: () =>
      apiFetch<BankAccount[]>(
        `/finance/accounts?organizationId=${organizationId}`
      ),
    enabled: !!organizationId,
  });
}

export function useSelectedAccount(
  organizationId: string | null
): [string | null, (id: string | null) => void] {
  const accounts = useBankAccounts(organizationId);
  const [selected, setSelected] = useState<string | null>(() =>
    localStorage.getItem(ACCT_KEY)
  );
  useEffect(() => {
    if (!accounts.data?.length) return;
    if (!selected || !accounts.data.some((a) => a.id === selected)) {
      const first = accounts.data[0]!.id;
      setSelected(first);
      localStorage.setItem(ACCT_KEY, first);
    }
  }, [accounts.data, selected]);
  function update(id: string | null) {
    setSelected(id);
    if (id) localStorage.setItem(ACCT_KEY, id);
    else localStorage.removeItem(ACCT_KEY);
  }
  return [selected, update];
}
