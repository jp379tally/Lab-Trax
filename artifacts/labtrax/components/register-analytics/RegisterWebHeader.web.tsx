import React from "react";
import { View } from "react-native";
import { formatMoney } from "@/lib/format";
import { RegisterAnalyticsWeb } from "./RegisterAnalyticsWeb";
import type { RegisterWebHeaderProps } from "./RegisterWebHeader";
export type { RegisterWebFilters, RegisterWebHeaderProps } from "./RegisterWebHeader";

export function RegisterWebHeader(p: RegisterWebHeaderProps) {
  const a = p.accounts.find((a) => a.id === p.accountId);
  const money = (v: string | number | null | undefined) => v == null || !Number.isFinite(Number(v)) ? "Unavailable" : formatMoney(Number(v));
  const uncleared = a?.bookBalance != null && a.clearedBalance != null ? Number(a.bookBalance) - Number(a.clearedBalance) : undefined;
  const inputStyle = { border: "1px solid #dbe4ed", borderRadius: 6, padding: "9px 10px", fontSize: 12, minWidth: 0, maxWidth: "100%", background: "#fff", color: "#1e293b" } as const;
  const buttonStyle = { ...inputStyle, cursor: "pointer", minHeight: 40 } as const;
  return (
    <View>
      <div style={{ padding: 16, background: "#f1f7fc", color: "#1e293b", fontFamily: "inherit", minWidth: 0 }}>
        <style>{`.register-web-balances{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}@media(max-width:360px){.register-web-balances{grid-template-columns:minmax(0,1fr)}}`}</style>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ flex: "1 1 190px" }}><strong>Financial / Bank Register</strong><div style={{ fontSize: 12, marginTop: 4 }}>{a?.institution || a?.name || "Choose an account"}{a?.last4 ? ` ··${a.last4}` : ""}</div></div>
          <select aria-label="Bank account" value={p.accountId ?? ""} onChange={(e) => p.onSelectAccount(e.target.value)} style={inputStyle}>
            {!a && <option value="">Choose account</option>}
            {p.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {p.canImport && p.onImport && <button type="button" style={buttonStyle} onClick={p.onImport}>Import Statement</button>}
          <button type="button" style={buttonStyle} onClick={p.onRefresh}>Refresh</button>
        </div>
        <div className="register-web-balances">
          {[
            { label: "Book Balance", value: a?.bookBalance, bg: "#e7f1ff", color: "#1562ce" },
            { label: "Cleared Balance", value: a?.clearedBalance, bg: "#e6f6ef", color: "#087f5b" },
            { label: "Uncleared", value: uncleared, bg: "#fff2e6", color: "#c65c11" },
            { label: "Unreconciled", value: a?.unreconciledBalance, bg: "#edf1f5", color: "#475569" },
          ].map((c) => <div key={c.label} style={{ padding: 14, borderRadius: 10, border: "1px solid #dbe4ed", background: c.bg, minWidth: 0 }}>
            <div style={{ color: c.color, fontSize: 11, fontWeight: 600 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6, overflowWrap: "anywhere" }}>{money(c.value)}</div>
            <div style={{ fontSize: 10, marginTop: 5, color: "#64748b" }}>All-time selected account</div>
          </div>)}
        </div>
      </div>
      {p.accountId && <RegisterAnalyticsWeb organizationId={p.organizationId} accountId={p.accountId} />}
      <div style={{ padding: 16, display: "flex", flexWrap: "wrap", gap: 8, background: "#f1f7fc", color: "#1e293b" }}>
        <input type="search" aria-label="Search register" placeholder="Search payee, memo, check #…" value={p.search} onChange={(e) => p.onSearchChange(e.target.value)} style={{ ...inputStyle, flex: "1 1 180px" }} />
        <select aria-label="Register status" value={p.status} onChange={(e) => p.onStatusChange(e.target.value)} style={inputStyle}>
          {["all", "posted", "projected", "uncleared", "unreconciled", "void"].map((s) => <option key={s} value={s}>{s === "all" ? "All status" : s}</option>)}
        </select>
        <select aria-label="Register category" value={p.filters.categoryId} onChange={(e) => p.onFiltersChange({ ...p.filters, categoryId: e.target.value })} style={inputStyle}>
          <option value="">All categories</option>{p.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label style={{ fontSize: 11 }}>From <input aria-label="Register from" type="date" value={p.filters.dateFrom} onChange={(e) => p.onFiltersChange({ ...p.filters, dateFrom: e.target.value })} style={inputStyle} /></label>
        <label style={{ fontSize: 11 }}>To <input aria-label="Register to" type="date" value={p.filters.dateTo} onChange={(e) => p.onFiltersChange({ ...p.filters, dateTo: e.target.value })} style={inputStyle} /></label>
        <details style={{ fontSize: 12, padding: 8 }}><summary style={{ cursor: "pointer" }}>Amount filters</summary>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {(["amountMin", "amountMax"] as const).map((key) => <label key={key}>{key === "amountMin" ? "Min signed amount" : "Max signed amount"}<input aria-label={key === "amountMin" ? "Minimum signed amount" : "Maximum signed amount"} type="number" step="0.01" value={p.filters[key]} onChange={(e) => p.onFiltersChange({ ...p.filters, [key]: e.target.value })} style={{ ...inputStyle, width: 110, marginLeft: 6 }} /></label>)}
          </div>
        </details>
        <button type="button" onClick={p.onReset} style={buttonStyle}>Reset</button>
      </div>
    </View>
  );
}
