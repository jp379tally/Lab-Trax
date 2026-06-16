import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, ChevronsUpDown, ChevronUp, ChevronDown as ChevronDownIcon, Download, GripVertical, History, Loader2, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { formatDate, formatMoney, formatPhone } from "@/lib/format";
import type { BankTransaction } from "@/lib/types";

type SortDir = "asc" | "desc";

function SortTh({
  label,
  sortKey,
  active,
  dir,
  onClick,
  className = "",
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: SortDir;
  onClick: (key: string) => void;
  className?: string;
}) {
  return (
    <th
      className={`text-left font-medium px-3 py-2 cursor-pointer select-none whitespace-nowrap group ${className}`}
      onClick={() => onClick(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === "asc" ? <ChevronUp size={11} className="opacity-70" /> : <ChevronDownIcon size={11} className="opacity-70" />
        ) : (
          <ChevronsUpDown size={11} className="opacity-0 group-hover:opacity-40 transition-opacity" />
        )}
      </span>
    </th>
  );
}

type VendorType = "vendor" | "employee" | "item";

interface Vendor {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  unitPrice: string | null;
  itemCategory: string | null;
  vendorType: VendorType;
  isActive: boolean;
}

interface Category {
  id: string;
  name: string;
  kind: string;
  color: string | null;
  description: string | null;
  isArchived: boolean;
}

const TYPE_TABS: { key: VendorType; label: string }[] = [
  { key: "vendor", label: "Vendors" },
  { key: "employee", label: "Employees" },
  { key: "item", label: "Billable Items" },
];

const TYPE_BADGE: Record<VendorType, string> = {
  vendor: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  employee: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  item: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

const TYPE_LABEL: Record<VendorType, string> = {
  vendor: "Vendor",
  employee: "Employee",
  item: "Billable Item",
};

const KIND_BADGE: Record<string, string> = {
  income: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  expense: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  transfer: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
};

const KIND_LABEL: Record<string, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

type Tab = VendorType | "categories" | "locations";

interface Location {
  id: string;
  labOrganizationId: string;
  name: string;
  code: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
}

interface LocationForm {
  name: string;
  code: string;
  isActive: boolean;
}

interface VendorForm {
  name: string;
  vendorType: VendorType;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
  website: string;
  notes: string;
  unitPrice: string;
  itemCategory: string;
  isActive: boolean;
}

interface CategoryForm {
  name: string;
  kind: "income" | "expense" | "transfer";
  color: string;
  description: string;
  isActive: boolean;
}

const emptyLocationForm = (): LocationForm => ({
  name: "",
  code: "",
  isActive: true,
});

const emptyVendorForm = (type: VendorType = "vendor"): VendorForm => ({
  name: "",
  vendorType: type,
  address: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
  email: "",
  website: "",
  notes: "",
  unitPrice: "",
  itemCategory: "",
  isActive: true,
});

const emptyCategoryForm = (): CategoryForm => ({
  name: "",
  kind: "expense",
  color: "",
  description: "",
  isActive: true,
});

export default function ListsPage() {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<any>("/auth/me"),
  });

  const orgId: string | undefined = meQuery.data?.memberships?.find(
    (m: any) => m.status === "active" && m.organization?.type === "lab"
  )?.organizationId;

  if (meQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  if (!orgId) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-2">
        <p>No active lab membership found on this account.</p>
        <p className="text-xs">Lists are scoped to a lab organization. Ask an admin to add you to a lab to see this page.</p>
      </div>
    );
  }

  return <ListsContent organizationId={orgId} />;
}

function ListsContent({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("vendor");
  const [search, setSearch] = useState("");
  const [showDrawer, setShowDrawer] = useState(false);
  const [drawerVendor, setDrawerVendor] = useState<Vendor | null>(null);
  const [drawerCategory, setDrawerCategory] = useState<Category | null>(null);
  const [drawerLocation, setDrawerLocation] = useState<Location | null>(null);
  const [vendorForm, setVendorForm] = useState<VendorForm>(emptyVendorForm("vendor"));
  const [categoryForm, setCategoryForm] = useState<CategoryForm>(emptyCategoryForm());
  const [locationForm, setLocationForm] = useState<LocationForm>(emptyLocationForm());
  const [txnsVendor, setTxnsVendor] = useState<Vendor | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [confirmDeactivateItem, setConfirmDeactivateItem] = useState<Vendor | null>(null);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<Vendor | null>(null);
  const [confirmDeleteLocation, setConfirmDeleteLocation] = useState<Location | null>(null);

  const vendorsQuery = useQuery({
    queryKey: ["finance", "vendors", organizationId, "all"],
    queryFn: () =>
      apiFetch<Vendor[]>(
        `/finance/vendors?organizationId=${organizationId}&includeInactive=true`
      ),
    enabled: !!organizationId,
  });

  const catsQuery = useQuery({
    queryKey: ["finance", "categories", organizationId, "all"],
    queryFn: () =>
      apiFetch<Category[]>(`/finance/categories?organizationId=${organizationId}`),
    enabled: !!organizationId,
  });

  const locationsQuery = useQuery({
    queryKey: ["locations", organizationId, "all"],
    queryFn: () =>
      apiFetch<Location[]>(`/locations?organizationId=${organizationId}`),

    enabled: !!organizationId,
  });

  const allVendors = vendorsQuery.data ?? [];
  const allCategories = catsQuery.data ?? [];
  const allLocations = locationsQuery.data ?? [];

  // Support deep-linking to a specific vendor via ?vendor=<id>
  // (e.g. from the recurring rules list badge).
  const [autoOpenedVendorId, setAutoOpenedVendorId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const vendorId = params.get("vendor");
    if (!vendorId || vendorId === autoOpenedVendorId) return;
    const v = allVendors.find((x) => x.id === vendorId);
    if (!v) return;
    setActiveTab(v.vendorType as Tab);
    openEditVendor(v);
    setAutoOpenedVendorId(vendorId);
    const url = new URL(window.location.href);
    url.searchParams.delete("vendor");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allVendors]);

  function invalidateVendors() {
    qc.invalidateQueries({ queryKey: ["finance", "vendors", organizationId] });
  }
  function invalidateCategories() {
    qc.invalidateQueries({ queryKey: ["finance", "categories", organizationId] });
  }
  function invalidateLocations() {
    qc.invalidateQueries({ queryKey: ["locations", organizationId] });
  }

  const createVendorMut = useMutation({
    mutationFn: (form: VendorForm) =>
      apiFetch("/finance/vendors", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name: form.name.trim(),
          vendorType: form.vendorType,
          address: form.address.trim() || null,
          city: form.city.trim() || null,
          state: form.state.trim() || null,
          zip: form.zip.trim() || null,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          website: form.website.trim() || null,
          notes: form.notes.trim() || null,
          unitPrice: form.vendorType === "item" ? (form.unitPrice.trim() || null) : null,
          itemCategory: form.vendorType === "item" ? (form.itemCategory.trim() || null) : null,
          isActive: form.isActive,
        }),
      }),
    onSuccess: () => {
      closeDrawer();
      invalidateVendors();
    },
  });

  const updateVendorMut = useMutation({
    mutationFn: ({ id, form }: { id: string; form: VendorForm }) =>
      apiFetch(`/finance/vendors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.trim(),
          vendorType: form.vendorType,
          address: form.address.trim() || null,
          city: form.city.trim() || null,
          state: form.state.trim() || null,
          zip: form.zip.trim() || null,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          website: form.website.trim() || null,
          notes: form.notes.trim() || null,
          unitPrice: form.vendorType === "item" ? (form.unitPrice.trim() || null) : null,
          itemCategory: form.vendorType === "item" ? (form.itemCategory.trim() || null) : null,
          isActive: form.isActive,
        }),
      }),
    onSuccess: () => {
      closeDrawer();
      invalidateVendors();
    },
  });

  const deactivateItemMut = useMutation({
    mutationFn: (v: Vendor) =>
      apiFetch(`/finance/vendors/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: v.name,
          vendorType: v.vendorType,
          address: v.address,
          city: v.city,
          state: v.state,
          zip: v.zip,
          phone: v.phone,
          email: v.email,
          website: v.website,
          notes: v.notes,
          isActive: false,
        }),
      }),
    onSuccess: (_data, v) => {
      setConfirmDeactivateItem(null);
      invalidateVendors();
      toast.success(`"${v.name}" deactivated`);
    },
    onError: () => {
      toast.error("Failed to deactivate item");
    },
  });

  const deleteItemMut = useMutation({
    mutationFn: (v: Vendor) =>
      apiFetch(`/finance/vendors/${v.id}?hard=true`, {
        method: "DELETE",
      }),
    onSuccess: (_data, v) => {
      setConfirmDeleteItem(null);
      invalidateVendors();
      toast.success(`"${v.name}" deleted`);
    },
    onError: () => {
      toast.error("Failed to delete item");
    },
  });

  const createCatMut = useMutation({
    mutationFn: (form: CategoryForm) =>
      apiFetch("/finance/categories", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name: form.name.trim(),
          kind: form.kind,
          color: form.color || null,
          description: form.description.trim() || null,
        }),
      }),
    onSuccess: () => {
      closeDrawer();
      invalidateCategories();
    },
  });

  const updateCatMut = useMutation({
    mutationFn: ({ id, form }: { id: string; form: CategoryForm }) =>
      apiFetch(`/finance/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.trim(),
          kind: form.kind,
          color: form.color || null,
          description: form.description.trim() || null,
          isArchived: !form.isActive,
        }),
      }),
    onSuccess: () => {
      closeDrawer();
      invalidateCategories();
    },
  });

  const deactivateCatMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/categories/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      closeDrawer();
      invalidateCategories();
    },
  });

  const createLocationMut = useMutation({
    mutationFn: (form: LocationForm) =>
      apiFetch("/locations", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name: form.name.trim(),
          code: form.code.trim(),
          isActive: form.isActive,

        }),
      }),
    onSuccess: () => {
      closeDrawer();
      invalidateLocations();
      toast.success("Location added");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to add location");
    },
  });

  const updateLocationMut = useMutation({
    mutationFn: ({ id, form }: { id: string; form: LocationForm }) =>
      apiFetch(`/locations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.trim(),
          code: form.code.trim(),
          isActive: form.isActive,

        }),
      }),
    onSuccess: () => {
      closeDrawer();
      invalidateLocations();
      toast.success("Location updated");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to update location");
    },
  });

  const deleteLocationMut = useMutation({
    mutationFn: (loc: Location) =>
      apiFetch(`/locations/${loc.id}`, { method: "DELETE" }),
    onSuccess: (_data, loc) => {
      setConfirmDeleteLocation(null);
      invalidateLocations();
      toast.success(`"${loc.name}" deleted`);
    },
    onError: () => {
      toast.error("Failed to delete location");
    },
  });

  const toggleLocationActiveMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch(`/locations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: (_data, vars) => {
      invalidateLocations();
      toast.success(vars.isActive ? "Location activated" : "Location deactivated");
    },
    onError: () => {
      toast.error("Failed to update location");
    },
  });

  async function handleLocationReorder(ordered: Location[]) {
    const original = [...allLocations].sort((a, b) => a.sortOrder - b.sortOrder);
    const changed = ordered.filter((loc, i) => {
      const orig = original.find((l) => l.id === loc.id);
      return orig === undefined || orig.sortOrder !== i;
    });
    if (changed.length === 0) return;
    try {
      await Promise.all(
        changed.map((loc) =>
          apiFetch(`/locations/${loc.id}`, {
            method: "PATCH",
            body: JSON.stringify({ sortOrder: loc.sortOrder }),
          })
        )
      );
      invalidateLocations();
      toast.success("Order saved");
    } catch {
      toast.error("Failed to save new order");
      invalidateLocations();
    }
  }

  function openAddVendor(type: VendorType) {
    setDrawerVendor(null);
    setDrawerCategory(null);
    setVendorForm(emptyVendorForm(type));
    setShowDrawer(true);
  }

  function openEditVendor(v: Vendor) {
    setDrawerVendor(v);
    setDrawerCategory(null);
    setVendorForm({
      name: v.name,
      vendorType: v.vendorType,
      address: v.address ?? "",
      city: v.city ?? "",
      state: v.state ?? "",
      zip: v.zip ?? "",
      phone: v.phone ?? "",
      email: v.email ?? "",
      website: v.website ?? "",
      notes: v.notes ?? "",
      unitPrice: v.unitPrice ?? "",
      itemCategory: v.itemCategory ?? "",
      isActive: v.isActive,
    });
    setShowDrawer(true);
  }

  function openAddCategory() {
    setDrawerVendor(null);
    setDrawerCategory(null);
    setDrawerLocation(null);
    setCategoryForm(emptyCategoryForm());
    setShowDrawer(true);
  }

  function openEditCategory(c: Category) {
    setDrawerVendor(null);
    setDrawerCategory(c);
    setDrawerLocation(null);
    setCategoryForm({
      name: c.name,
      kind: c.kind as CategoryForm["kind"],
      color: c.color ?? "",
      description: c.description ?? "",
      isActive: !c.isArchived,
    });
    setShowDrawer(true);
  }

  function openAddLocation() {
    setDrawerVendor(null);
    setDrawerCategory(null);
    setDrawerLocation(null);
    setLocationForm(emptyLocationForm());
    setShowDrawer(true);
  }

  function openEditLocation(loc: Location) {
    setDrawerVendor(null);
    setDrawerCategory(null);
    setDrawerLocation(loc);
    setLocationForm({ name: loc.name, code: loc.code, isActive: loc.isActive });
    setShowDrawer(true);
  }

  function closeDrawer() {
    setShowDrawer(false);
    setDrawerVendor(null);
    setDrawerCategory(null);
    setDrawerLocation(null);
  }

  const isCategoriesTab = activeTab === "categories";
  const isLocationsTab = activeTab === "locations";

  const filteredVendors = allVendors
    .filter((v) => v.vendorType === (activeTab as VendorType))
    .filter(
      (v) =>
        !search.trim() ||
        v.name.toLowerCase().includes(search.toLowerCase()) ||
        (v.email ?? "").toLowerCase().includes(search.toLowerCase()) ||
        (v.phone ?? "").includes(search) ||
        (v.city ?? "").toLowerCase().includes(search.toLowerCase())
    );

  const filteredCategories = allCategories.filter(
    (c) =>
      !search.trim() ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.kind.toLowerCase().includes(search.toLowerCase())
  );

  const filteredLocations = allLocations.filter(
    (loc) =>
      !search.trim() ||
      loc.name.toLowerCase().includes(search.toLowerCase()) ||
      loc.code.toLowerCase().includes(search.toLowerCase())
  );

  const tabCounts: Record<Tab, number> = {
    vendor: allVendors.filter((v) => v.vendorType === "vendor").length,
    employee: allVendors.filter((v) => v.vendorType === "employee").length,
    item: allVendors.filter((v) => v.vendorType === "item").length,
    categories: allCategories.length,
    locations: allLocations.length,
  };

  const allTabs: { key: Tab; label: string }[] = [
    ...TYPE_TABS,
    { key: "categories", label: "Categories" },
    { key: "locations", label: "Locations" },
  ];

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    setSearch("");
    setShowDrawer(false);
  }

  const isVendorPending = createVendorMut.isPending || updateVendorMut.isPending;
  const isCatPending = createCatMut.isPending || updateCatMut.isPending;
  const isLocationPending = createLocationMut.isPending || updateLocationMut.isPending;
  const vendorError =
    (createVendorMut.error instanceof Error ? createVendorMut.error.message : null) ||
    (updateVendorMut.error instanceof Error ? updateVendorMut.error.message : null);
  const catError =
    (createCatMut.error instanceof Error ? createCatMut.error.message : null) ||
    (updateCatMut.error instanceof Error ? updateCatMut.error.message : null);
  const locationError =
    (createLocationMut.error instanceof Error ? createLocationMut.error.message : null) ||
    (updateLocationMut.error instanceof Error ? updateLocationMut.error.message : null);

  function handleExportCsv() {
    const type = activeTab as VendorType;
    const rows = allVendors.filter((v) => v.vendorType === type && v.isActive);
    const isItem = type === "item";
    const headers = ["Name", "Phone", "Email", "Address", "City", "State", "Zip", "Website", "Notes", ...(isItem ? ["Unit Price"] : [])];
    const csvLines = [
      headers.join(","),
      ...rows.map((v) =>
        [v.name, v.phone ?? "", v.email ?? "", v.address ?? "", v.city ?? "", v.state ?? "", v.zip ?? "", v.website ?? "", v.notes ?? "", ...(isItem ? [v.unitPrice ?? ""] : [])]
          .map((val) => `"${String(val).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ];
    const blob = new Blob([csvLines.join("\r\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${TYPE_LABEL[type].toLowerCase()}s-export.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${TYPE_LABEL[type]}s exported`, {
      description: `${rows.length} record${rows.length !== 1 ? "s" : ""} downloaded as CSV.`,
    });
  }

  return (
    <div className="space-y-5 relative">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lists</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage vendors, employees, billable items, transaction categories, and lab locations used across the register.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-4 pt-3 pb-0">
            <nav className="flex gap-1 -mb-px">
              {allTabs.map((t) => {
                const count = tabCounts[t.key];
                const active = activeTab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => handleTabChange(t.key)}
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
              placeholder={`Search ${isLocationsTab ? "locations" : isCategoriesTab ? "categories" : TYPE_LABEL[activeTab as VendorType].toLowerCase() + "s"}…`}
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <div className="flex-1" />
          {!isCategoriesTab && !isLocationsTab && (
            <>
              <button
                type="button"
                onClick={handleExportCsv}
                title="Export CSV"
                className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5"
              >
                <Download size={14} />
                Export CSV
              </button>
              {(activeTab === "vendor" || activeTab === "employee" || activeTab === "item") && (
                <button
                  type="button"
                  onClick={() => setShowImportDialog(true)}
                  title="Import CSV"
                  className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5"
                >
                  <Upload size={14} />
                  Import CSV
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() =>
              isLocationsTab
                ? openAddLocation()
                : isCategoriesTab
                  ? openAddCategory()
                  : openAddVendor(activeTab as VendorType)
            }
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5"
          >
            <Plus size={14} />
            Add {isLocationsTab ? "Location" : isCategoriesTab ? "Category" : TYPE_LABEL[activeTab as VendorType]}
          </button>
        </div>

        {isLocationsTab ? (
          <LocationsTable
            locations={filteredLocations}
            isLoading={locationsQuery.isLoading}
            search={search}
            onEdit={openEditLocation}
            onDelete={(loc) => setConfirmDeleteLocation(loc)}
            onReorder={handleLocationReorder}
            onToggleActive={(loc) =>
              toggleLocationActiveMut.mutate({ id: loc.id, isActive: !loc.isActive })
            }
            toggleActivePendingId={toggleLocationActiveMut.isPending ? toggleLocationActiveMut.variables?.id : undefined}
          />
        ) : isCategoriesTab ? (
          <CategoriesTable
            categories={filteredCategories}
            isLoading={catsQuery.isLoading}
            search={search}
            onEdit={openEditCategory}
          />
        ) : (
          <VendorsTable
            vendors={filteredVendors}
            isLoading={vendorsQuery.isLoading}
            search={search}
            typeLabel={TYPE_LABEL[activeTab as VendorType]}
            vendorType={activeTab as VendorType}
            onEdit={openEditVendor}
            onDeactivate={activeTab === "item" ? (v) => setConfirmDeactivateItem(v) : undefined}
            onDelete={activeTab === "item" ? (v) => setConfirmDeleteItem(v) : undefined}
          />
        )}
      </div>

      {txnsVendor && (
        <VendorTransactionsModal
          organizationId={organizationId}
          vendor={txnsVendor}
          onClose={() => setTxnsVendor(null)}
        />
      )}

      {showImportDialog && (activeTab === "vendor" || activeTab === "employee" || activeTab === "item") && (
        <ImportCsvDialog
          organizationId={organizationId}
          vendorType={activeTab}
          onClose={() => setShowImportDialog(false)}
          onSuccess={(count) => {
            setShowImportDialog(false);
            invalidateVendors();
            const typeLabel = TYPE_LABEL[activeTab as VendorType];
            toast.success(`${count} ${typeLabel.toLowerCase()}${count !== 1 ? "s" : ""} imported successfully`);
          }}
        />
      )}

      {confirmDeactivateItem && (
        <>
          <div
            className="fixed inset-0 z-50 bg-foreground/30"
            onClick={() => setConfirmDeactivateItem(null)}
          />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[360px] bg-card border border-border rounded-xl shadow-2xl flex flex-col">
            <div className="px-5 pt-5 pb-4">
              <h3 className="text-sm font-semibold mb-1">Deactivate Billable Item?</h3>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">"{confirmDeactivateItem.name}"</span> will be
                marked inactive and hidden from case and invoice forms. You can re-activate it later by editing
                it in this list.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 pb-4">
              <button
                type="button"
                onClick={() => setConfirmDeactivateItem(null)}
                disabled={deactivateItemMut.isPending}
                className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deactivateItemMut.mutate(confirmDeactivateItem)}
                disabled={deactivateItemMut.isPending}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {deactivateItemMut.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Ban size={13} />
                )}
                Deactivate
              </button>
            </div>
          </div>
        </>
      )}

      {confirmDeleteItem && (
        <>
          <div
            className="fixed inset-0 z-50 bg-foreground/30"
            onClick={() => setConfirmDeleteItem(null)}
          />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[360px] bg-card border border-border rounded-xl shadow-2xl flex flex-col">
            <div className="px-5 pt-5 pb-4">
              <h3 className="text-sm font-semibold mb-1">Delete Billable Item?</h3>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">"{confirmDeleteItem.name}"</span> will be
                permanently removed from this list. Existing cases and invoices that already reference it are
                not affected. This cannot be undone from the app.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 pb-4">
              <button
                type="button"
                onClick={() => setConfirmDeleteItem(null)}
                disabled={deleteItemMut.isPending}
                className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteItemMut.mutate(confirmDeleteItem)}
                disabled={deleteItemMut.isPending}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {deleteItemMut.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                Delete
              </button>
            </div>
          </div>
        </>
      )}

      {confirmDeleteLocation && (
        <>
          <div
            className="fixed inset-0 z-50 bg-foreground/30"
            onClick={() => setConfirmDeleteLocation(null)}
          />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[360px] bg-card border border-border rounded-xl shadow-2xl flex flex-col">
            <div className="px-5 pt-5 pb-4">
              <h3 className="text-sm font-semibold mb-1">Delete Location?</h3>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">"{confirmDeleteLocation.name}"</span> will be
                permanently removed. Cases that referenced this location are not affected. This cannot be undone.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 pb-4">
              <button
                type="button"
                onClick={() => setConfirmDeleteLocation(null)}
                disabled={deleteLocationMut.isPending}
                className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteLocationMut.mutate(confirmDeleteLocation)}
                disabled={deleteLocationMut.isPending}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {deleteLocationMut.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                Delete
              </button>
            </div>
          </div>
        </>
      )}

      {showDrawer && (
        <>
          <div
            className="fixed inset-0 z-40 bg-foreground/20"
            onClick={closeDrawer}
          />
          <div className="fixed right-0 top-0 bottom-0 w-[420px] z-50 bg-card border-l border-border shadow-2xl flex flex-col">
            <header className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <h2 className="text-sm font-semibold">
                {isLocationsTab
                  ? drawerLocation
                    ? "Edit Location"
                    : "New Location"
                  : isCategoriesTab
                    ? drawerCategory
                      ? "Edit Category"
                      : "New Category"
                    : drawerVendor
                      ? `Edit ${TYPE_LABEL[vendorForm.vendorType]}`
                      : `New ${TYPE_LABEL[vendorForm.vendorType]}`}
              </h2>
              <button
                type="button"
                onClick={closeDrawer}
                className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
              >
                <X size={15} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {!isCategoriesTab && !isLocationsTab && drawerVendor && (
                <VendorTransactionSummary
                  organizationId={organizationId}
                  vendor={drawerVendor}
                  onViewAll={() => setTxnsVendor(drawerVendor)}
                />
              )}
              {isLocationsTab ? (
                <LocationFormFields form={locationForm} onChange={setLocationForm} error={locationError} />
              ) : isCategoriesTab ? (
                <CategoryFormFields form={categoryForm} onChange={setCategoryForm} error={catError} />
              ) : (
                <VendorFormFields
                  form={vendorForm}
                  onChange={setVendorForm}
                  error={vendorError}
                  existingItemNames={allVendors
                    .filter((v) => v.vendorType === "item" && v.isActive)
                    .map((v) => v.name)
                    .sort((a, b) => a.localeCompare(b))}
                />
              )}
            </div>

            <footer className="px-5 py-4 border-t border-border shrink-0 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDrawer}
                className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80"
              >
                Cancel
              </button>
              {isLocationsTab && drawerLocation && (
                <button
                  type="button"
                  onClick={() =>
                    updateLocationMut.mutate({ id: drawerLocation.id, form: locationForm })
                  }
                  disabled={!locationForm.name.trim() || !locationForm.code.trim() || isLocationPending}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {isLocationPending && <Loader2 size={13} className="animate-spin" />}
                  Save changes
                </button>
              )}
              {isLocationsTab && !drawerLocation && (
                <button
                  type="button"
                  onClick={() => createLocationMut.mutate(locationForm)}
                  disabled={!locationForm.name.trim() || !locationForm.code.trim() || isLocationPending}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {isLocationPending && <Loader2 size={13} className="animate-spin" />}
                  Add Location
                </button>
              )}
              {!isLocationsTab && !isCategoriesTab && drawerVendor && (
                <button
                  type="button"
                  onClick={() =>
                    updateVendorMut.mutate({ id: drawerVendor.id, form: vendorForm })
                  }
                  disabled={!vendorForm.name.trim() || isVendorPending}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {isVendorPending && <Loader2 size={13} className="animate-spin" />}
                  Save changes
                </button>
              )}
              {!isLocationsTab && !isCategoriesTab && !drawerVendor && (
                <button
                  type="button"
                  onClick={() => createVendorMut.mutate(vendorForm)}
                  disabled={!vendorForm.name.trim() || isVendorPending}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {isVendorPending && <Loader2 size={13} className="animate-spin" />}
                  Add {TYPE_LABEL[vendorForm.vendorType]}
                </button>
              )}
              {isCategoriesTab && drawerCategory && (
                <button
                  type="button"
                  onClick={() =>
                    updateCatMut.mutate({ id: drawerCategory.id, form: categoryForm })
                  }
                  disabled={!categoryForm.name.trim() || isCatPending}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {isCatPending && <Loader2 size={13} className="animate-spin" />}
                  Save changes
                </button>
              )}
              {isCategoriesTab && !drawerCategory && (
                <button
                  type="button"
                  onClick={() => createCatMut.mutate(categoryForm)}
                  disabled={!categoryForm.name.trim() || isCatPending}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {isCatPending && <Loader2 size={13} className="animate-spin" />}
                  Add Category
                </button>
              )}
            </footer>
          </div>
        </>
      )}
    </div>
  );
}

function CategoriesTable({
  categories,
  isLoading,
  search,
  onEdit,
}: {
  categories: Category[];
  isLoading: boolean;
  search: string;
  onEdit: (c: Category) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof Category>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(key: string) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key as keyof Category); setSortDir("asc"); }
  }

  const sorted = [...categories].sort((a, b) => {
    const av = String(a[sortKey] ?? "").toLowerCase();
    const bv = String(b[sortKey] ?? "").toLowerCase();
    return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Loading…
      </div>
    );
  }
  if (categories.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {search.trim()
          ? "No categories match your search."
          : "No categories yet. Click \"Add Category\" to create one."}
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
        <tr>
          <SortTh label="Name" sortKey="name" active={sortKey === "name"} dir={sortDir} onClick={handleSort} className="px-4" />
          <SortTh label="Kind" sortKey="kind" active={sortKey === "kind"} dir={sortDir} onClick={handleSort} className="w-32" />
          <SortTh label="Description" sortKey="description" active={sortKey === "description"} dir={sortDir} onClick={handleSort} />
          <th className="text-left font-medium px-3 py-2 w-20">Color</th>
          <th className="text-center font-medium px-3 py-2 w-20">Active</th>
          <th className="px-2 py-2 w-16" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((c) => (
          <tr
            key={c.id}
            className={`border-t border-border hover:bg-secondary/20 ${c.isArchived ? "opacity-50" : ""}`}
          >
            <td className="px-4 py-2.5 font-medium">
              {c.name}
              {c.isArchived && (
                <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground font-normal">
                  inactive
                </span>
              )}
            </td>
            <td className="px-3 py-2.5">
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${KIND_BADGE[c.kind] ?? "bg-secondary text-muted-foreground"}`}
              >
                {KIND_LABEL[c.kind] ?? c.kind}
              </span>
            </td>
            <td className="px-3 py-2.5 text-muted-foreground text-xs truncate max-w-[240px]">
              {c.description || "—"}
            </td>
            <td className="px-3 py-2.5">
              {c.color ? (
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-4 w-4 rounded-full border border-border"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="text-xs text-muted-foreground">{c.color}</span>
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </td>
            <td className="px-3 py-2.5 text-center">
              <span
                className={`inline-block h-2 w-2 rounded-full ${!c.isArchived ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
              />
            </td>
            <td className="px-2 py-2.5 text-right">
              <button
                type="button"
                onClick={() => onEdit(c)}
                className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label="Edit"
              >
                <Pencil size={13} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VendorsTable({
  vendors,
  isLoading,
  search,
  typeLabel,
  vendorType,
  onEdit,
  onDeactivate,
  onDelete,
}: {
  vendors: Vendor[];
  isLoading: boolean;
  search: string;
  typeLabel: string;
  vendorType: VendorType;
  onEdit: (v: Vendor) => void;
  onDeactivate?: (v: Vendor) => void;
  onDelete?: (v: Vendor) => void;
}) {
  const isItem = vendorType === "item";
  const [sortKey, setSortKey] = useState<keyof Vendor>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(key: string) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key as keyof Vendor); setSortDir("asc"); }
  }

  const sorted = [...vendors].sort((a, b) => {
    const av = String(a[sortKey] ?? "").toLowerCase();
    const bv = String(b[sortKey] ?? "").toLowerCase();
    return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Loading…
      </div>
    );
  }
  if (vendors.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {search.trim()
          ? "No results match your search."
          : `No ${typeLabel.toLowerCase()}s yet. Click "Add ${typeLabel}" to create one.`}
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
        <tr>
          <SortTh label="Name" sortKey="name" active={sortKey === "name"} dir={sortDir} onClick={handleSort} className="px-4" />
          {isItem ? (
            <SortTh label="Price" sortKey="unitPrice" active={sortKey === "unitPrice"} dir={sortDir} onClick={handleSort} className="w-28" />
          ) : (
            <>
              <SortTh label="Phone" sortKey="phone" active={sortKey === "phone"} dir={sortDir} onClick={handleSort} />
              <SortTh label="Email" sortKey="email" active={sortKey === "email"} dir={sortDir} onClick={handleSort} />
              <SortTh label="City" sortKey="city" active={sortKey === "city"} dir={sortDir} onClick={handleSort} />
            </>
          )}
          <SortTh label="Type" sortKey="vendorType" active={sortKey === "vendorType"} dir={sortDir} onClick={handleSort} className="w-28" />
          <th className="text-center font-medium px-3 py-2 w-20">Active</th>
          <th className="px-2 py-2 w-16" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((v) => (
          <tr
            key={v.id}
            className={`border-t border-border hover:bg-secondary/20 ${!v.isActive ? "opacity-50" : ""}`}
          >
            <td className="px-4 py-2.5 font-medium">
              {v.name}
              {!v.isActive && (
                <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground font-normal">
                  inactive
                </span>
              )}
            </td>
            {isItem ? (
              <td className="px-3 py-2.5 text-muted-foreground text-xs tabular-nums">
                {v.unitPrice != null ? formatMoney(parseFloat(v.unitPrice)) : "—"}
              </td>
            ) : (
              <>
                <td className="px-3 py-2.5 text-muted-foreground text-xs">
                  {v.phone ? formatPhone(v.phone) : "—"}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground text-xs truncate max-w-[180px]">
                  {v.email || "—"}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground text-xs">
                  {v.city || "—"}
                </td>
              </>
            )}
            <td className="px-3 py-2.5">
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TYPE_BADGE[v.vendorType]}`}
              >
                {TYPE_LABEL[v.vendorType]}
              </span>
            </td>
            <td className="px-3 py-2.5 text-center">
              <span
                className={`inline-block h-2 w-2 rounded-full ${v.isActive ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
              />
            </td>
            <td className="px-2 py-2.5 text-right">
              <div className="flex items-center justify-end gap-1">
                {onDeactivate && v.isActive && (
                  <button
                    type="button"
                    onClick={() => onDeactivate(v)}
                    className="h-7 w-7 rounded-md hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive"
                    aria-label="Deactivate"
                    title="Deactivate"
                  >
                    <Ban size={13} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onEdit(v)}
                  className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label="Edit"
                >
                  <Pencil size={13} />
                </button>
                {onDelete && (
                  <button
                    type="button"
                    onClick={() => onDelete(v)}
                    className="h-7 w-7 rounded-md hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive"
                    aria-label="Delete"
                    title="Delete permanently"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LocationsTable({
  locations,
  isLoading,
  search,
  onEdit,
  onDelete,
  onReorder,
  onToggleActive,
  toggleActivePendingId,
}: {
  locations: Location[];
  isLoading: boolean;
  search: string;
  onEdit: (loc: Location) => void;
  onDelete: (loc: Location) => void;
  onReorder: (ordered: Location[]) => void;
  onToggleActive: (loc: Location) => void;
  toggleActivePendingId?: string;
}) {
  const isDraggable = !search.trim();

  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [localRows, setLocalRows] = useState<Location[]>([]);

  useEffect(() => {
    setLocalRows([...locations].sort((a, b) => a.sortOrder - b.sortOrder));
  }, [locations]);

  function handleDragStart(idx: number) {
    dragIdx.current = idx;
  }

  function handleDragEnter(idx: number) {
    setOverIdx(idx);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(dropIdx: number) {
    const from = dragIdx.current;
    if (from === null || from === dropIdx) {
      dragIdx.current = null;
      setOverIdx(null);
      return;
    }
    const next = [...localRows];
    const [moved] = next.splice(from, 1);
    next.splice(dropIdx, 0, moved);
    const reindexed = next.map((loc, i) => ({ ...loc, sortOrder: i }));
    setLocalRows(reindexed);
    dragIdx.current = null;
    setOverIdx(null);
    const changed = reindexed.filter((loc, i) => loc.sortOrder !== locations[i]?.sortOrder || loc.id !== locations.find((l) => l.sortOrder === loc.sortOrder)?.id);
    if (changed.length > 0) onReorder(reindexed);
  }

  function handleDragEnd() {
    dragIdx.current = null;
    setOverIdx(null);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Loading…
      </div>
    );
  }
  if (locations.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {search.trim()
          ? "No locations match your search."
          : "No locations yet. Click \"Add Location\" to create one."}
      </div>
    );
  }

  const displayRows = isDraggable ? localRows : [...locations].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <table className="w-full text-sm">
      <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
        <tr>
          {isDraggable && <th className="px-2 py-2 w-8" />}
          <th className="text-left font-medium px-4 py-2">Name</th>
          <th className="text-left font-medium px-3 py-2 w-32">Code</th>
          <th className="text-center font-medium px-3 py-2 w-20">Active</th>
          <th className="px-2 py-2 w-20" />
        </tr>
      </thead>
      <tbody>
        {displayRows.map((loc, idx) => {
          const isOver = overIdx === idx && dragIdx.current !== null && dragIdx.current !== idx;
          const isDragging = isDraggable && dragIdx.current === idx;
          return (
            <tr
              key={loc.id}
              draggable={isDraggable}
              onDragStart={isDraggable ? () => handleDragStart(idx) : undefined}
              onDragEnter={isDraggable ? () => handleDragEnter(idx) : undefined}
              onDragOver={isDraggable ? handleDragOver : undefined}
              onDrop={isDraggable ? () => handleDrop(idx) : undefined}
              onDragEnd={isDraggable ? handleDragEnd : undefined}
              className={[
                "border-t border-border",
                !loc.isActive ? "opacity-50" : "",
                isDragging ? "opacity-40" : "",
                isOver ? "bg-primary/8 border-t-2 border-t-primary" : "hover:bg-secondary/20",
              ].join(" ")}
            >
              {isDraggable && (
                <td className="px-2 py-2.5 text-muted-foreground/50 cursor-grab active:cursor-grabbing select-none">
                  <GripVertical size={14} />
                </td>
              )}
              <td className="px-4 py-2.5 font-medium">{loc.name}</td>
              <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{loc.code}</td>
              <td className="px-3 py-2.5 text-center">
                {toggleActivePendingId === loc.id ? (
                  <Loader2 size={13} className="animate-spin text-muted-foreground inline-block" />
                ) : (
                  <button
                    type="button"
                    onClick={() => onToggleActive(loc)}
                    aria-label={loc.isActive ? "Deactivate location" : "Activate location"}
                    title={loc.isActive ? "Click to deactivate" : "Click to activate"}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      loc.isActive ? "bg-primary" : "bg-muted"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                        loc.isActive ? "translate-x-4" : "translate-x-1"
                      }`}
                    />
                  </button>
                )}
              </td>
              <td className="px-2 py-2.5 text-right">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onEdit(loc)}
                    className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label="Edit"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(loc)}
                    className="h-7 w-7 rounded-md hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive"
                    aria-label="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LocationFormFields({
  form,
  onChange,
  error,
}: {
  form: LocationForm;
  onChange: (f: LocationForm) => void;
  error: string | null;
}) {
  const set = (patch: Partial<LocationForm>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-4">
      <FieldRow label="Name *">
        <input
          className={inputCls}
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Wax / Metal / Porcelain"
          autoFocus
        />
      </FieldRow>
      <FieldRow label="Code *">
        <input
          className={inputCls}
          value={form.code}
          onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          placeholder="e.g. WAX"
          maxLength={20}
        />
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Short identifier used as the case status value. Must be unique per lab.
        </p>
      </FieldRow>
      <FieldRow label="Status">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => set({ isActive: !form.isActive })}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
              form.isActive ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                form.isActive ? "translate-x-4" : "translate-x-1"
              }`}
            />
          </button>
          <span className="text-sm">{form.isActive ? "Active" : "Inactive"}</span>
        </div>
      </FieldRow>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-foreground/80">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-ring";
const textareaCls =
  "w-full px-2.5 py-1.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none";

function VendorFormFields({
  form,
  onChange,
  error,
  existingItemNames = [],
}: {
  form: VendorForm;
  onChange: (f: VendorForm) => void;
  error: string | null;
  existingItemNames?: string[];
}) {
  const set = (patch: Partial<VendorForm>) => onChange({ ...form, ...patch });
  const isItem = form.vendorType === "item";

  // For billable-item forms: track whether the user is picking an existing name or entering a new one
  const [itemNameMode, setItemNameMode] = useState<"pick" | "add_new">(() => {
    if (!isItem) return "pick";
    if (!form.name) return "pick";
    if (existingItemNames.includes(form.name)) return "pick";
    return "add_new";
  });

  const ActiveToggle = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => set({ isActive: !form.isActive })}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
          form.isActive ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
            form.isActive ? "translate-x-4" : "translate-x-1"
          }`}
        />
      </button>
      <span className="text-sm">{form.isActive ? "Active" : "Inactive"}</span>
    </div>
  );

  if (isItem) {
    return (
      <div className="space-y-4">
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>
        )}
        <FieldRow label="Item *">
          {itemNameMode === "pick" ? (
            <select
              autoFocus
              value={form.name}
              onChange={(e) => {
                if (e.target.value === "__add_new__") {
                  setItemNameMode("add_new");
                  set({ name: "" });
                } else {
                  set({ name: e.target.value });
                }
              }}
              className={inputCls}
            >
              <option value="">— Select a billable item —</option>
              {existingItemNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
              <option value="__add_new__">+ Add New</option>
            </select>
          ) : (
            <div className="flex gap-2">
              <input
                autoFocus
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="New billable item name"
                className={`${inputCls} flex-1`}
              />
              {existingItemNames.length > 0 && (
                <button
                  type="button"
                  onClick={() => { setItemNameMode("pick"); set({ name: "" }); }}
                  className="h-9 px-3 rounded-md bg-secondary text-sm hover:bg-secondary/80 whitespace-nowrap"
                >
                  Pick existing
                </button>
              )}
            </div>
          )}
        </FieldRow>
        <FieldRow label="Type">
          <select
            value={form.itemCategory}
            onChange={(e) => set({ itemCategory: e.target.value })}
            className={inputCls}
          >
            <option value="">— Select a type —</option>
            <option value="Restorative">Restorative</option>
            <option value="Removable">Removable</option>
            <option value="Appliance">Appliance</option>
          </select>
        </FieldRow>
        <FieldRow label="Unit Price">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm select-none">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.unitPrice}
              onChange={(e) => set({ unitPrice: e.target.value })}
              placeholder="0.00"
              className={`${inputCls} pl-6`}
            />
          </div>
        </FieldRow>
        <FieldRow label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Internal notes…"
            rows={3}
            className={textareaCls}
          />
        </FieldRow>
        {ActiveToggle}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>
      )}
      <FieldRow label="Name *">
        <input
          autoFocus
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Full name"
          className={inputCls}
        />
      </FieldRow>
      <FieldRow label="Type">
        <select
          value={form.vendorType}
          onChange={(e) => set({ vendorType: e.target.value as VendorType })}
          className={inputCls}
        >
          <option value="vendor">Vendor</option>
          <option value="employee">Employee</option>
          <option value="item">Billable Item</option>
        </select>
      </FieldRow>
      <FieldRow label="Phone">
        <input
          value={form.phone}
          onChange={(e) => set({ phone: e.target.value })}
          placeholder="(555) 555-5555"
          className={inputCls}
        />
      </FieldRow>
      <FieldRow label="Email">
        <input
          type="email"
          value={form.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="name@example.com"
          className={inputCls}
        />
      </FieldRow>
      <FieldRow label="Website">
        <input
          value={form.website}
          onChange={(e) => set({ website: e.target.value })}
          placeholder="https://example.com"
          className={inputCls}
        />
      </FieldRow>
      <FieldRow label="Address">
        <input
          value={form.address}
          onChange={(e) => set({ address: e.target.value })}
          placeholder="Street address"
          className={inputCls}
        />
      </FieldRow>
      <div className="grid grid-cols-3 gap-2">
        <FieldRow label="City">
          <input
            value={form.city}
            onChange={(e) => set({ city: e.target.value })}
            placeholder="City"
            className={inputCls}
          />
        </FieldRow>
        <FieldRow label="State">
          <input
            value={form.state}
            onChange={(e) => set({ state: e.target.value })}
            placeholder="CA"
            className={inputCls}
          />
        </FieldRow>
        <FieldRow label="ZIP">
          <input
            value={form.zip}
            onChange={(e) => set({ zip: e.target.value })}
            placeholder="90210"
            className={inputCls}
          />
        </FieldRow>
      </div>
      <FieldRow label="Notes">
        <textarea
          value={form.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="Internal notes…"
          rows={3}
          className={textareaCls}
        />
      </FieldRow>
      {ActiveToggle}
    </div>
  );
}

function VendorTransactionSummary({
  organizationId,
  vendor,
  onViewAll,
}: {
  organizationId: string;
  vendor: Vendor;
  onViewAll: () => void;
}) {
  const q = useQuery({
    queryKey: ["finance", "txns", "vendor-summary", organizationId, vendor.name],
    queryFn: () =>
      apiFetch<BankTransaction[]>(
        `/finance/transactions?organizationId=${encodeURIComponent(organizationId)}&payee=${encodeURIComponent(vendor.name)}`
      ),
    staleTime: 30_000,
  });

  const txns = q.data ?? [];
  const count = txns.length;
  const totalPayments = txns.reduce((s, t) => s + Number(t.debitAmount), 0);
  const totalDeposits = txns.reduce((s, t) => s + Number(t.creditAmount), 0);

  return (
    <div className="mb-5 rounded-lg border border-border bg-secondary/30 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground/80">Transaction history</span>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <History size={11} />
          View transactions
        </button>
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          Loading…
        </div>
      ) : q.isError ? (
        <p className="text-xs text-destructive">Could not load transactions.</p>
      ) : count === 0 ? (
        <p className="text-xs text-muted-foreground">No transactions found for this payee.</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{count}</span>{" "}
            {count === 1 ? "transaction" : "transactions"}
          </span>
          {totalPayments > 0 && (
            <span>
              Payments:{" "}
              <span className="font-medium text-foreground">{formatMoney(totalPayments)}</span>
            </span>
          )}
          {totalDeposits > 0 && (
            <span>
              Deposits:{" "}
              <span className="font-medium text-foreground">{formatMoney(totalDeposits)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const TXN_TYPE_BADGE: Record<string, string> = {
  payment: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  deposit: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  transfer: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
};

function VendorTransactionsModal({
  organizationId,
  vendor,
  onClose,
}: {
  organizationId: string;
  vendor: Vendor;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["finance", "txns", "vendor-detail", organizationId, vendor.name],
    queryFn: () =>
      apiFetch<BankTransaction[]>(
        `/finance/transactions?organizationId=${encodeURIComponent(organizationId)}&payee=${encodeURIComponent(vendor.name)}`
      ),
    staleTime: 30_000,
  });

  const txns = q.data ?? [];
  const count = txns.length;
  const totalPayments = txns.reduce((s, t) => s + Number(t.debitAmount), 0);
  const totalDeposits = txns.reduce((s, t) => s + Number(t.creditAmount), 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-foreground/30"
        onClick={onClose}
      />
      <div className="relative w-full max-w-4xl max-h-[85vh] bg-card border border-border rounded-xl shadow-2xl flex flex-col">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold">
              Transactions — {vendor.name}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              All register entries where payee matches this{" "}
              {TYPE_LABEL[vendor.vendorType].toLowerCase()}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
          >
            <X size={15} />
          </button>
        </header>

        {!q.isLoading && count > 0 && (
          <div className="px-5 py-3 border-b border-border shrink-0 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">{count}</span>{" "}
              {count === 1 ? "transaction" : "transactions"}
            </span>
            {totalPayments > 0 && (
              <span className="text-muted-foreground">
                Total payments:{" "}
                <span className="font-semibold text-foreground">{formatMoney(totalPayments)}</span>
              </span>
            )}
            {totalDeposits > 0 && (
              <span className="text-muted-foreground">
                Total deposits:{" "}
                <span className="font-semibold text-foreground">{formatMoney(totalDeposits)}</span>
              </span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Loading transactions…
            </div>
          ) : q.isError ? (
            <div className="py-16 text-center text-sm text-destructive">
              Could not load transactions. Please try again.
            </div>
          ) : count === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No transactions found for <strong>{vendor.name}</strong>.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-secondary/60 backdrop-blur text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2 w-28">Date</th>
                  <th className="text-left font-medium px-3 py-2 w-24">Type</th>
                  <th className="text-left font-medium px-3 py-2">Memo</th>
                  <th className="text-right font-medium px-3 py-2 w-28">Payment</th>
                  <th className="text-right font-medium px-3 py-2 w-28">Deposit</th>
                  <th className="text-left font-medium px-3 py-2 w-20">Status</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => {
                  const payment = Number(t.debitAmount);
                  const deposit = Number(t.creditAmount);
                  return (
                    <tr key={t.id} className="border-t border-border hover:bg-secondary/20">
                      <td className="px-4 py-2.5 tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(t.txnDate)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            TXN_TYPE_BADGE[t.type] ?? "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {t.type}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[240px]">
                        {t.memo || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                        {payment > 0 ? (
                          <span className="text-rose-600 dark:text-rose-400 font-medium">
                            {formatMoney(payment)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                        {deposit > 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                            {formatMoney(deposit)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            t.status === "void"
                              ? "bg-muted text-muted-foreground line-through"
                              : t.status === "projected"
                              ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                              : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {t.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}


function CategoryFormFields({
  form,
  onChange,
  error,
}: {
  form: CategoryForm;
  onChange: (f: CategoryForm) => void;
  error: string | null;
}) {
  const set = (patch: Partial<CategoryForm>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>
      )}
      <FieldRow label="Name *">
        <input
          autoFocus
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Office supplies"
          className={inputCls}
        />
      </FieldRow>
      <FieldRow label="Kind">
        <select
          value={form.kind}
          onChange={(e) => set({ kind: e.target.value as CategoryForm["kind"] })}
          className={inputCls}
        >
          <option value="expense">Expense</option>
          <option value="income">Income</option>
          <option value="transfer">Transfer</option>
        </select>
      </FieldRow>
      <FieldRow label="Color">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={form.color || "#6366f1"}
            onChange={(e) => set({ color: e.target.value })}
            className="h-9 w-12 rounded-md border border-input cursor-pointer bg-background p-1"
          />
          <input
            value={form.color}
            onChange={(e) => set({ color: e.target.value })}
            placeholder="#6366f1 (optional)"
            className={`${inputCls} flex-1`}
          />
          {form.color && (
            <button
              type="button"
              onClick={() => set({ color: "" })}
              className="h-9 w-9 flex items-center justify-center rounded-md hover:bg-secondary text-muted-foreground"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </FieldRow>
      <FieldRow label="Description">
        <textarea
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Optional description…"
          rows={2}
          className={textareaCls}
        />
      </FieldRow>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => set({ isActive: !form.isActive })}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
            form.isActive ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
              form.isActive ? "translate-x-4" : "translate-x-1"
            }`}
          />
        </button>
        <span className="text-sm">{form.isActive ? "Active" : "Inactive"}</span>
      </div>
    </div>
  );
}

// ─── CSV utilities ────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => parseCsvLine(l));
  return { headers, rows };
}

const VENDOR_FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: "name", label: "Name", required: true },
  { key: "phone", label: "Phone", required: false },
  { key: "email", label: "Email", required: false },
  { key: "address", label: "Address", required: false },
  { key: "city", label: "City", required: false },
  { key: "state", label: "State", required: false },
  { key: "zip", label: "Zip", required: false },
  { key: "website", label: "Website", required: false },
  { key: "notes", label: "Notes", required: false },
];

const ITEM_FIELDS: { key: string; label: string; required: boolean }[] = [
  ...VENDOR_FIELDS,
  { key: "unitPrice", label: "Unit Price", required: false },
];

function getFieldsForType(vendorType: VendorType) {
  return vendorType === "item" ? ITEM_FIELDS : VENDOR_FIELDS;
}

function autoDetectMapping(headers: string[], vendorType: VendorType): Record<string, number> {
  const mapping: Record<string, number> = {};
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const aliases: Record<string, string[]> = {
    name: ["name", "fullname", "vendorname", "employeename", "itemname", "product", "productname", "company", "companyname", "businessname"],
    phone: ["phone", "telephone", "phonenumber", "mobile", "cell", "fax"],
    email: ["email", "emailaddress", "mail"],
    address: ["address", "streetaddress", "street", "addr"],
    city: ["city", "town"],
    state: ["state", "province", "region"],
    zip: ["zip", "zipcode", "postalcode", "postal"],
    website: ["website", "url", "web", "homepage", "site"],
    notes: ["notes", "note", "comments", "comment", "description", "memo"],
    unitPrice: ["unitprice", "price", "cost", "unitcost", "rate", "amount", "unitamount", "priceeach", "costeach"],
  };
  for (const field of getFieldsForType(vendorType)) {
    const fieldAliases = aliases[field.key] ?? [field.key];
    const idx = headers.findIndex((h) => fieldAliases.includes(normalize(h)));
    if (idx !== -1) mapping[field.key] = idx;
  }
  return mapping;
}

// ─── ImportCsvDialog ─────────────────────────────────────────────────────────

type ImportStep = "upload" | "mapping" | "done";

function ImportCsvDialog({
  organizationId,
  vendorType,
  onClose,
  onSuccess,
}: {
  organizationId: string;
  vendorType: VendorType;
  onClose: () => void;
  onSuccess: (count: number) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<ImportStep>("upload");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const typeLabel = TYPE_LABEL[vendorType];

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers, rows } = parseCsv(text);
      if (headers.length === 0) {
        setImportError("The CSV file appears to be empty or invalid.");
        return;
      }
      setCsvHeaders(headers);
      setCsvRows(rows.filter((r) => r.some((c) => c.trim())));
      setMapping(autoDetectMapping(headers, vendorType));
      setImportError(null);
      setStep("mapping");
    };
    reader.readAsText(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function setFieldMapping(fieldKey: string, colIndex: number) {
    setMapping((prev) => ({ ...prev, [fieldKey]: colIndex }));
  }

  const previewRows = csvRows.slice(0, 5);

  function getMappedValue(row: string[], fieldKey: string): string {
    const idx = mapping[fieldKey];
    if (idx === undefined || idx < 0) return "";
    return row[idx] ?? "";
  }

  async function handleImport() {
    setImportError(null);
    const records = csvRows
      .map((row) => {
        const name = getMappedValue(row, "name").trim();
        if (!name) return null;
        const record: Record<string, string | null> & { name: string } = {
          name,
          phone: getMappedValue(row, "phone") || null,
          email: getMappedValue(row, "email") || null,
          address: getMappedValue(row, "address") || null,
          city: getMappedValue(row, "city") || null,
          state: getMappedValue(row, "state") || null,
          zip: getMappedValue(row, "zip") || null,
          website: getMappedValue(row, "website") || null,
          notes: getMappedValue(row, "notes") || null,
        };
        if (vendorType === "item") {
          record.unitPrice = getMappedValue(row, "unitPrice") || null;
        }
        return record;
      })
      .filter(Boolean) as Array<{ name: string } & Record<string, string | null>>;

    if (records.length === 0) {
      setImportError("No valid records found. Make sure the Name column is mapped correctly.");
      return;
    }

    setImporting(true);
    try {
      const endpoint =
        vendorType === "employee"
          ? "/finance/employees/import"
          : vendorType === "item"
            ? "/finance/items/import"
            : "/finance/vendors/import";
      const result = await apiFetch<{ imported: number; skipped: number }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ organizationId, records }),
      });
      setImportedCount(result.imported);
      setSkippedCount(result.skipped ?? 0);
      setStep("done");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed.";
      setImportError(message);
      toast.error("Import failed", { description: message });
    } finally {
      setImporting(false);
    }
  }

  const validRecordCount = csvRows.filter((row) => getMappedValue(row, "name").trim()).length;
  const nameIsMapped = mapping["name"] !== undefined && (mapping["name"] as number) >= 0;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-foreground/30" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <h2 className="text-sm font-semibold">Import {typeLabel}s from CSV</h2>
            <button
              type="button"
              onClick={onClose}
              className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
            >
              <X size={15} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {step === "upload" && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Upload a CSV file with your {typeLabel.toLowerCase()} list. The first row should be column headers.
                </p>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                    dragOver
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-secondary/30"
                  }`}
                >
                  <Upload size={24} className="mx-auto mb-3 text-muted-foreground" />
                  <p className="text-sm font-medium">Drop a CSV file here, or click to browse</p>
                  <p className="text-xs text-muted-foreground mt-1">Supports .csv files up to 1,000 rows</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>
                {importError && (
                  <p className="text-sm text-destructive">{importError}</p>
                )}
              </div>
            )}

            {step === "mapping" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    {csvRows.length} row{csvRows.length !== 1 ? "s" : ""} detected. Map your CSV columns to {typeLabel.toLowerCase()} fields.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setStep("upload"); setCsvHeaders([]); setCsvRows([]); }}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    Choose different file
                  </button>
                </div>

                <div className="border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/40">
                      <tr>
                        <th className="text-left font-medium px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground w-1/3">LabTrax Field</th>
                        <th className="text-left font-medium px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">CSV Column</th>
                        <th className="text-left font-medium px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">Preview</th>
                      </tr>
                    </thead>
                    <tbody>
                      {getFieldsForType(vendorType).map((field) => {
                        const colIdx = mapping[field.key] ?? -1;
                        const preview = previewRows[0] ? (colIdx >= 0 ? previewRows[0][colIdx] ?? "" : "") : "";
                        return (
                          <tr key={field.key} className="border-t border-border">
                            <td className="px-3 py-2 font-medium text-xs">
                              {field.label}
                              {field.required && <span className="text-destructive ml-0.5">*</span>}
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={colIdx}
                                onChange={(e) => setFieldMapping(field.key, Number(e.target.value))}
                                className="w-full h-7 text-xs rounded border border-border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-primary"
                              >
                                <option value={-1}>— ignore —</option>
                                {csvHeaders.map((h, i) => (
                                  <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[140px]">
                              {preview || <span className="opacity-40">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {previewRows.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                      Preview (first {previewRows.length} row{previewRows.length !== 1 ? "s" : ""})
                    </p>
                    <div className="border border-border rounded-lg overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-secondary/40">
                          <tr>
                            {getFieldsForType(vendorType).filter((f) => mapping[f.key] !== undefined && (mapping[f.key] as number) >= 0).map((f) => (
                              <th key={f.key} className="text-left font-medium px-3 py-1.5 text-muted-foreground whitespace-nowrap">{f.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((row, ri) => (
                            <tr key={ri} className="border-t border-border">
                              {getFieldsForType(vendorType).filter((f) => mapping[f.key] !== undefined && (mapping[f.key] as number) >= 0).map((f) => (
                                <td key={f.key} className="px-3 py-1.5 text-muted-foreground truncate max-w-[150px]">
                                  {getMappedValue(row, f.key) || <span className="opacity-40">—</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {importError && (
                  <p className="text-sm text-destructive">{importError}</p>
                )}
              </div>
            )}

            {step === "done" && (
              <div className="py-8 text-center space-y-2">
                <div className="text-4xl mb-2">✓</div>
                <p className="text-sm font-semibold">Import complete</p>
                <p className="text-sm text-muted-foreground">
                  {importedCount} created
                  {skippedCount > 0 ? `, ${skippedCount} skipped (duplicate name)` : ""}.
                </p>
              </div>
            )}
          </div>

          <footer className="px-5 py-4 border-t border-border shrink-0 flex justify-between items-center gap-2">
            <div className="text-xs text-muted-foreground">
              {step === "mapping" && nameIsMapped && validRecordCount > 0 && (
                <span>{validRecordCount} record{validRecordCount !== 1 ? "s" : ""} ready to import</span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={step === "done" ? () => onSuccess(importedCount) : onClose}
                className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80"
              >
                {step === "done" ? "Close" : "Cancel"}
              </button>
              {step === "mapping" && (
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={!nameIsMapped || validRecordCount === 0 || importing}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {importing && <Loader2 size={13} className="animate-spin" />}
                  Import {validRecordCount > 0 ? `${validRecordCount} ` : ""}{typeLabel}{validRecordCount !== 1 ? "s" : ""}
                </button>
              )}
            </div>
          </footer>
        </div>
      </div>
    </>
  );
}
