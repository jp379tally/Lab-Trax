import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

vi.mock("@tanstack/react-query", async (original) => await original());
vi.mock("react-native", async (original) => {
  const native = await original<typeof import("react-native")>();
  return { ...native, SectionList: (p: {
    sections: Array<{ title: string; data: Array<{ id: string }> }>;
    ListHeaderComponent: React.ReactNode; ListFooterComponent: React.ReactNode; ListEmptyComponent: React.ReactNode;
    renderItem: (p: { item: { id: string } }) => React.ReactNode;
    renderSectionHeader: (p: { section: { title: string } }) => React.ReactNode;
  }) => <native.View>{p.ListHeaderComponent}
    {p.sections.length ? p.sections.map((s) => <native.View key={s.title}>{p.renderSectionHeader({ section: s })}
      {s.data.map((item) => <React.Fragment key={item.id}>{p.renderItem({ item })}</React.Fragment>)}
    </native.View>) : p.ListEmptyComponent}
    {p.ListFooterComponent}
  </native.View> };
});
vi.mock("@/lib/auth-me", async (original) => ({
  ...(await original<typeof import("@/lib/auth-me")>()),
  useMe: () => ({ data: { memberships: [{ organizationId: "lab-1", role: "admin", status: "active", organization: { id: "lab-1", type: "lab", name: "Lab" } }] } }),
}));
const getJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/read-api", async (original) => ({
  ...(await original<typeof import("@/lib/read-api")>()), getJson,
}));
vi.mock("@/components/register-analytics/RegisterWebHeader", async () => {
  const { View, TextInput, Pressable, Text } = await import("react-native");
  return { RegisterWebHeader: (p: import("@/components/register-analytics/RegisterWebHeader").RegisterWebHeaderProps) => (
    <View>
      <TextInput testID="web-search" value={p.search} onChangeText={p.onSearchChange} />
      <TextInput testID="web-category" value={p.filters.categoryId} onChangeText={(categoryId) => p.onFiltersChange({ ...p.filters, categoryId })} />
      <TextInput testID="web-date" value={p.filters.dateTo} onChangeText={(dateTo) => p.onFiltersChange({ ...p.filters, dateTo })} />
      <TextInput testID="web-amount" value={p.filters.amountMin} onChangeText={(amountMin) => p.onFiltersChange({ ...p.filters, amountMin })} />
      <Pressable testID="web-reset" onPress={p.onReset}><Text>Reset</Text></Pressable>
      <Pressable testID="web-refresh" onPress={p.onRefresh}><Text>Refresh</Text></Pressable>
      <Pressable testID="web-account" onPress={() => p.onSelectAccount("account-b")}><Text>Switch</Text></Pressable>
    </View>
  ) };
});
import BankRegisterScreen from "../finance/bank-register";

const row = (id: string, payee = id) => ({ id, payee, txnDate: "2026-09-01", debitAmount: "1", creditAmount: "0", runningBalance: "-1", status: "posted" });
const requests = () => getJson.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/finance/transactions"));
const originalOS = Platform.OS;
let queryClient: QueryClient;
beforeEach(() => {
  Platform.OS = "web";
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  setMockAppState({ meMemberships: [{ organizationId: "lab-1", role: "admin", status: "active", organization: { id: "lab-1", type: "lab", name: "Lab" } }] });
  getJson.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("/finance/accounts")) return [{ id: "account-a", name: "Checking" }, { id: "account-b", name: "Savings" }];
    if (url.includes("/finance/categories")) return [{ id: "cat", name: "Expense" }];
    const p = new URLSearchParams(url.split("?")[1]);
    if (Platform.OS !== "web") return [row("native-entry")];
    if (p.get("bankAccountId") === "account-b") return { rows: [row("switched-entry")], total: 1, hasMore: false };
    if (p.get("search")) return { rows: [row("filtered-entry")], total: 1, hasMore: false };
    if (p.get("cursor")) return { rows: [row("first-entry", "updated-entry"), row("second-entry")], total: 2, hasMore: false };
    return { rows: [row("first-entry")], total: 2, hasMore: true, nextCursor: "next" };
  });
});
afterEach(async () => { await cleanup(); queryClient.clear(); Platform.OS = originalOS; resetMockAppState(); });
function show() { return render(<QueryClientProvider client={queryClient}><BankRegisterScreen /></QueryClientProvider>); }
describe("mobile website bank register query contract", () => {
  it("uses bounded cursors, dedupes, resets immediately by query identity, and leaves native requests unpaged", async () => {
    const screen = await show();
    await screen.findByText("first-entry");
    expect(requests()[0]).toContain("limit=30");
    await fireEvent.press(screen.getByTestId("bank-register-load-more"));
    await screen.findByText("second-entry");
    expect(screen.queryByText("first-entry")).toBeNull();
    expect(screen.getAllByText("updated-entry")).toHaveLength(1);
    expect(requests().at(-1)).toContain("cursor=next");
    await fireEvent.changeText(screen.getByTestId("web-search"), "filter");
    await screen.findByText("filtered-entry");
    expect(screen.queryByText("second-entry")).toBeNull();
    expect(requests().at(-1)).not.toContain("cursor=");
    await fireEvent.press(screen.getByTestId("web-account"));
    await screen.findByText("switched-entry");
    expect(requests().at(-1)).toContain("bankAccountId=account-b");
    await cleanup();
    queryClient.clear();
    Platform.OS = "ios";
    const native = await show();
    await native.findByText("native-entry");
    expect(requests().at(-1)).not.toMatch(/limit=|cursor=|amountMin=|dateTo=/);
    expect(native.queryByTestId("web-reset")).toBeNull();
  });
  it("wires category, inclusive end date and signed amounts, then resets every list filter", async () => {
    const screen = await show();
    await screen.findByText("first-entry");
    await fireEvent.changeText(screen.getByTestId("web-category"), "cat");
    await fireEvent.changeText(screen.getByTestId("web-date"), "2026-09-02");
    await fireEvent.changeText(screen.getByTestId("web-amount"), "-20");
    await waitFor(() => {
      const p = new URLSearchParams(requests().at(-1)!.split("?")[1]);
      expect(p.get("categoryId")).toBe("cat");
      expect(p.get("dateTo")).toBe("2026-09-02T23:59:59.999Z");
      expect(p.get("amountMin")).toBe("-20");
    });
    await fireEvent.press(screen.getByTestId("web-reset"));
    await waitFor(() => {
      expect(screen.getByTestId("web-category").props.value).toBe("");
      expect(screen.getByTestId("web-date").props.value).toBe("");
      expect(screen.getByTestId("web-amount").props.value).toBe("");
      const active = queryClient.getQueryCache().findAll({ queryKey: ["bank-transactions"], type: "active" });
      expect(String(active[0].queryKey[1])).not.toMatch(/categoryId=|dateTo=|amountMin=/);
    });
  });
  it("restarts accumulated pages on confirmed invalidation and refreshes analytics and balances together", async () => {
    const screen = await show();
    await screen.findByText("first-entry");
    await fireEvent.press(screen.getByTestId("bank-register-load-more"));
    await screen.findByText("second-entry");
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(["bank-transactions", "analytics", "lab-1"], { totalEntries: 25 });
    await fireEvent.press(screen.getByTestId("web-refresh"));
    await waitFor(() => expect(screen.queryByText("second-entry")).toBeNull());
    expect(spy).toHaveBeenCalledWith({ queryKey: ["bank-transactions"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["finance-accounts"] });
    expect(queryClient.getQueryState(["bank-transactions", "analytics", "lab-1"])?.isInvalidated).toBe(true);
    expect(requests().at(-1)).not.toContain("cursor=");
  });
  it("shows refresh failures without replacing previous entries with an empty register", async () => {
    const screen = await show();
    await screen.findByText("first-entry");
    getJson.mockImplementation(async (url: string) => {
      if (url.includes("/finance/transactions")) throw new Error("Offline");
      if (url.includes("/finance/accounts")) return [{ id: "account-a", name: "Checking" }];
      return [];
    });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["bank-transactions"] }); });
    await screen.findByText(/Couldn’t refresh register/);
    expect(screen.getByText("first-entry")).toBeTruthy();
    expect(screen.queryByText("No transactions")).toBeNull();
  });
});
