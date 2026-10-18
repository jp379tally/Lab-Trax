export interface RegisterWebFilters {
  categoryId: string;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
}
export interface RegisterWebHeaderProps {
  organizationId: string;
  accounts: Array<{ id: string; name: string; institution?: string | null; last4?: string | null; bookBalance?: string | number | null; clearedBalance?: string | number | null; unreconciledBalance?: string | number | null }>;
  accountId: string | null;
  onSelectAccount: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  status: string;
  onStatusChange: (value: string) => void;
  categories: Array<{ id: string; name: string }>;
  filters: RegisterWebFilters;
  onFiltersChange: (filters: RegisterWebFilters) => void;
  onReset: () => void;
  canImport: boolean;
  onImport?: () => void;
  onRefresh: () => void;
}
/** Native keeps its original header. */
export function RegisterWebHeader(_props: RegisterWebHeaderProps) { return null; }
