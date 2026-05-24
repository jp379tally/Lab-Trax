import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { formatPhone } from "@/lib/format";

type VendorType = "vendor" | "employee" | "item";

interface Vendor {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  vendorType: VendorType;
  isActive: boolean;
}

const TYPE_TABS: { key: VendorType; label: string; description: string }[] = [
  { key: "vendor", label: "Vendors", description: "Suppliers and service providers" },
  { key: "employee", label: "Employees", description: "Staff paid through the check register" },
  { key: "item", label: "Items", description: "Lab supplies like Zirconia, EMAX, etc." },
];

const TYPE_BADGE: Record<VendorType, string> = {
  vendor: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  employee: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  item: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

const TYPE_LABEL: Record<VendorType, string> = {
  vendor: "Vendor",
  employee: "Employee",
  item: "Item",
};

function useVendors(organizationId: string) {
  return useQuery({
    queryKey: ["finance", "vendors", organizationId, "all"],
    queryFn: () =>
      apiFetch<Vendor[]>(
        `/finance/vendors?organizationId=${organizationId}&includeInactive=true`
      ),
    enabled: !!organizationId,
  });
}

interface FormState {
  name: string;
  phone: string;
  address: string;
  vendorType: VendorType;
  isActive: boolean;
}

const emptyForm = (defaultType: VendorType = "vendor"): FormState => ({
  name: "",
  phone: "",
  address: "",
  vendorType: defaultType,
  isActive: true,
});

function PayeesContent({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const vendorsQuery = useVendors(organizationId);
  const allVendors = vendorsQuery.data ?? [];

  const [activeTab, setActiveTab] = useState<VendorType>("vendor");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());

  const tabVendors = allVendors
    .filter((v) => v.vendorType === activeTab)
    .filter(
      (v) =>
        !search.trim() ||
        v.name.toLowerCase().includes(search.toLowerCase()) ||
        (v.address || "").toLowerCase().includes(search.toLowerCase()) ||
        (v.phone || "").includes(search)
    );

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["finance", "vendors", organizationId] });
  }

  const createMut = useMutation({
    mutationFn: (input: FormState) =>
      apiFetch("/finance/vendors", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name: input.name.trim(),
          phone: input.phone.trim() || null,
          address: input.address.trim() || null,
          vendorType: input.vendorType,
          isActive: input.isActive,
        }),
      }),
    onSuccess: () => {
      setShowForm(false);
      setForm(emptyForm(activeTab));
      invalidate();
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, input }: { id: string; input: FormState }) =>
      apiFetch(`/finance/vendors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: input.name.trim(),
          phone: input.phone.trim() || null,
          address: input.address.trim() || null,
          vendorType: input.vendorType,
          isActive: input.isActive,
        }),
      }),
    onSuccess: () => {
      setEditingId(null);
      setForm(emptyForm(activeTab));
      invalidate();
    },
  });

  const toggleActiveMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch(`/finance/vendors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => invalidate(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/vendors/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(),
  });

  function startEdit(v: Vendor) {
    setEditingId(v.id);
    setForm({
      name: v.name,
      phone: v.phone ?? "",
      address: v.address ?? "",
      vendorType: v.vendorType,
      isActive: v.isActive,
    });
    setShowForm(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm(activeTab));
  }

  function startAdd() {
    setEditingId(null);
    setForm(emptyForm(activeTab));
    setShowForm(true);
  }

  function cancelAdd() {
    setShowForm(false);
    setForm(emptyForm(activeTab));
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payees</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage vendors, employees, and supply items used in the check register.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-4 pt-3 pb-0">
            <nav className="flex gap-1 -mb-px">
              {TYPE_TABS.map((t) => {
                const count = allVendors.filter((v) => v.vendorType === t.key).length;
                const active = activeTab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(t.key);
                      setShowForm(false);
                      setEditingId(null);
                      setForm(emptyForm());
                      setSearch("");
                    }}
                    className={`px-3.5 py-2 text-sm font-medium border-b-2 transition-colors inline-flex items-center gap-1.5 ${
                      active
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}
                    {count > 0 && (
                      <span className="text-[11px] bg-secondary text-muted-foreground rounded-full px-1.5 py-0 leading-5 tabular-nums">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${TYPE_TABS.find((t) => t.key === activeTab)?.label.toLowerCase()}…`}
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={startAdd}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5"
          >
            <Plus size={14} /> Add {TYPE_LABEL[activeTab]}
          </button>
        </div>

        {showForm && (
          <PayeeForm
            form={form}
            setForm={setForm}
            typeLabel={TYPE_LABEL[activeTab]}
            onSave={() => createMut.mutate(form)}
            onCancel={cancelAdd}
            isPending={createMut.isPending}
            error={createMut.error instanceof Error ? createMut.error.message : null}
          />
        )}

        <div>
          {vendorsQuery.isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Loading…
            </div>
          )}

          {!vendorsQuery.isLoading && tabVendors.length === 0 && !showForm && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {search.trim()
                ? "No results match your search."
                : `No ${TYPE_TABS.find((t) => t.key === activeTab)?.label.toLowerCase()} yet. Click "Add ${TYPE_LABEL[activeTab]}" to create one.`}
            </div>
          )}

          {tabVendors.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Name</th>
                  <th className="text-left font-medium px-3 py-2">Phone</th>
                  <th className="text-left font-medium px-3 py-2">Address / Notes</th>
                  <th className="text-left font-medium px-3 py-2 w-28">Type</th>
                  <th className="text-center font-medium px-3 py-2 w-20">Active</th>
                  <th className="px-2 py-2 w-20" />
                </tr>
              </thead>
              <tbody>
                {tabVendors.map((v) =>
                  editingId === v.id ? (
                    <tr key={v.id} className="border-t border-border bg-secondary/10">
                      <td className="px-4 py-2">
                        <input
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          autoFocus
                          className="h-8 px-2 rounded-md bg-background border border-input text-sm w-full"
                          placeholder="Name"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={form.phone}
                          onChange={(e) => setForm({ ...form, phone: e.target.value })}
                          className="h-8 px-2 rounded-md bg-background border border-input text-sm w-full"
                          placeholder="Phone"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={form.address}
                          onChange={(e) => setForm({ ...form, address: e.target.value })}
                          className="h-8 px-2 rounded-md bg-background border border-input text-sm w-full"
                          placeholder="Address / notes"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={form.vendorType}
                          onChange={(e) => setForm({ ...form, vendorType: e.target.value as VendorType })}
                          className="h-8 px-2 rounded-md bg-background border border-input text-sm w-full"
                        >
                          <option value="vendor">Vendor</option>
                          <option value="employee">Employee</option>
                          <option value="item">Item</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={form.isActive}
                          onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => updateMut.mutate({ id: v.id, input: form })}
                            disabled={!form.name.trim() || updateMut.isPending}
                            className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={v.id}
                      className={`border-t border-border ${!v.isActive ? "opacity-50" : ""}`}
                    >
                      <td className="px-4 py-2.5 font-medium">
                        {v.name}
                        {!v.isActive && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground font-normal">
                            inactive
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">
                        {v.phone ? formatPhone(v.phone) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs truncate max-w-[240px]">
                        {v.address || "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TYPE_BADGE[v.vendorType]}`}
                        >
                          {TYPE_LABEL[v.vendorType]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          type="button"
                          onClick={() => toggleActiveMut.mutate({ id: v.id, isActive: !v.isActive })}
                          disabled={toggleActiveMut.isPending}
                          title={v.isActive ? "Mark inactive" : "Mark active"}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-60 ${
                            v.isActive ? "bg-primary" : "bg-muted"
                          }`}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                              v.isActive ? "translate-x-4" : "translate-x-1"
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <button
                            type="button"
                            onClick={() => startEdit(v)}
                            className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
                            aria-label="Edit"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (confirm(`Remove "${v.name}"? This will hide it from the autocomplete but won't affect history.`))
                                deleteMut.mutate(v.id);
                            }}
                            disabled={deleteMut.isPending}
                            className="h-7 w-7 rounded-md hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-50"
                            aria-label="Remove"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function PayeeForm({
  form,
  setForm,
  typeLabel,
  onSave,
  onCancel,
  isPending,
  error,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  typeLabel: string;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
}) {
  return (
    <div className="px-4 py-4 border-b border-border bg-secondary/5 space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        New {typeLabel}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          autoFocus
          placeholder={`${typeLabel} name *`}
          className="h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <input
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="Phone (optional)"
          className="h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <input
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          placeholder="Address / notes (optional)"
          className="h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <select
          value={form.vendorType}
          onChange={(e) => setForm({ ...form, vendorType: e.target.value as VendorType })}
          className="h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="vendor">Vendor</option>
          <option value="employee">Employee</option>
          <option value="item">Item</option>
        </select>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!form.name.trim() || isPending}
          className="h-8 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
        >
          {isPending && <Loader2 size={13} className="animate-spin" />}
          Save {typeLabel}
        </button>
      </div>
    </div>
  );
}

export default function PayeesPage() {
  return (
    <FinanceShell>
      {({ organizationId }) => <PayeesContent organizationId={organizationId} />}
    </FinanceShell>
  );
}
