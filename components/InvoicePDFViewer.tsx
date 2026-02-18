import React from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  Modal,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Invoice } from "@/lib/data";

interface InvoicePDFViewerProps {
  visible: boolean;
  onClose: () => void;
  invoice: Invoice | null;
}

function formatDate(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

function formatCurrency(amount: number) {
  return "$" + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export default function InvoicePDFViewer({ visible, onClose, invoice }: InvoicePDFViewerProps) {
  const insets = useSafeAreaInsets();

  if (!invoice) return null;

  const subtotal = invoice.lineItems.reduce((sum, li) => sum + li.amount, 0);
  const credits = invoice.credits || 0;
  const total = subtotal - credits;

  const statusColor =
    invoice.status === "paid" ? "#10B981" :
    invoice.status === "overdue" ? "#EF4444" :
    invoice.status === "sent" ? "#3B82F6" :
    "#F59E0B";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[s.container, { paddingTop: Platform.OS === "web" ? 67 : insets.top }]}>
        <View style={s.header}>
          <Pressable onPress={onClose} style={s.closeBtn}>
            <Ionicons name="arrow-back" size={22} color="#1E293B" />
          </Pressable>
          <Text style={s.headerTitle}>Invoice</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView
          style={s.scroll}
          contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 34 + 20 : insets.bottom + 20 }}
          showsVerticalScrollIndicator={false}
        >
          <View style={s.paper}>
            <View style={s.paperTopStripe} />

            <View style={s.paperContent}>
              <View style={s.topRow}>
                <View>
                  <Text style={s.labName}>LabTrax</Text>
                  <Text style={s.labDetail}>Dental Laboratory Services</Text>
                  <Text style={s.labDetail}>1234 Innovation Dr, Suite 100</Text>
                  <Text style={s.labDetail}>Pensacola, FL 32501</Text>
                  <Text style={s.labDetail}>(850) 555-0100</Text>
                </View>
                <View style={s.invoiceBadgeCol}>
                  <Text style={s.invoiceLabel}>INVOICE</Text>
                  <View style={[s.statusPill, { backgroundColor: statusColor + "18" }]}>
                    <View style={[s.statusDot, { backgroundColor: statusColor }]} />
                    <Text style={[s.statusPillText, { color: statusColor }]}>
                      {invoice.status.toUpperCase()}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={s.divider} />

              <View style={s.metaRow}>
                <View style={s.metaCol}>
                  <Text style={s.metaLabel}>Invoice #</Text>
                  <Text style={s.metaValue}>{invoice.invoiceNumber}</Text>
                </View>
                <View style={s.metaCol}>
                  <Text style={s.metaLabel}>Issue Date</Text>
                  <Text style={s.metaValue}>{formatDate(invoice.issuedAt)}</Text>
                </View>
                <View style={s.metaCol}>
                  <Text style={s.metaLabel}>Due Date</Text>
                  <Text style={s.metaValue}>{formatDate(invoice.dueAt)}</Text>
                </View>
              </View>

              <View style={s.billToSection}>
                <View style={s.billToCol}>
                  <Text style={s.billToLabel}>BILL TO</Text>
                  <Text style={s.billToName}>{invoice.billTo}</Text>
                  <Text style={s.billToDetail}>{invoice.clientName}</Text>
                </View>
                <View style={s.billToCol}>
                  <Text style={s.billToLabel}>PATIENT</Text>
                  <Text style={s.billToName}>{invoice.patientName}</Text>
                </View>
              </View>

              <View style={s.caseInfoBar}>
                <View style={s.caseInfoItem}>
                  <Text style={s.caseInfoLabel}>Case Type</Text>
                  <Text style={s.caseInfoValue}>{invoice.caseType || "—"}</Text>
                </View>
                <View style={s.caseInfoDivider} />
                <View style={s.caseInfoItem}>
                  <Text style={s.caseInfoLabel}>Teeth</Text>
                  <Text style={s.caseInfoValue}>{invoice.teeth || "—"}</Text>
                </View>
                <View style={s.caseInfoDivider} />
                <View style={s.caseInfoItem}>
                  <Text style={s.caseInfoLabel}>Shade</Text>
                  <Text style={s.caseInfoValue}>{invoice.shade || "—"}</Text>
                </View>
              </View>

              <View style={s.tableHeader}>
                <Text style={[s.tableHeaderText, s.colQty]}>QTY</Text>
                <Text style={[s.tableHeaderText, s.colItem]}>ITEM</Text>
                <Text style={[s.tableHeaderText, s.colDesc]}>DESCRIPTION</Text>
                <Text style={[s.tableHeaderText, s.colRate]}>RATE</Text>
                <Text style={[s.tableHeaderText, s.colAmount]}>AMOUNT</Text>
              </View>

              {invoice.lineItems.map((li, idx) => (
                <View key={idx} style={[s.tableRow, idx % 2 === 0 && s.tableRowAlt]}>
                  <Text style={[s.tableCell, s.colQty]}>{li.qty}</Text>
                  <Text style={[s.tableCell, s.colItem, s.tableCellBold]}>{li.item}</Text>
                  <Text style={[s.tableCell, s.colDesc]} numberOfLines={2}>{li.description}</Text>
                  <Text style={[s.tableCell, s.colRate]}>{formatCurrency(li.rate)}</Text>
                  <Text style={[s.tableCell, s.colAmount, s.tableCellBold]}>{formatCurrency(li.amount)}</Text>
                </View>
              ))}

              <View style={s.totalsSection}>
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>Subtotal</Text>
                  <Text style={s.totalValue}>{formatCurrency(subtotal)}</Text>
                </View>
                {credits > 0 && (
                  <View style={s.totalRow}>
                    <Text style={s.totalLabel}>Credits</Text>
                    <Text style={[s.totalValue, { color: "#10B981" }]}>-{formatCurrency(credits)}</Text>
                  </View>
                )}
                <View style={s.totalDivider} />
                <View style={[s.totalRow, s.grandTotalRow]}>
                  <Text style={s.grandTotalLabel}>Total Due</Text>
                  <Text style={s.grandTotalValue}>{formatCurrency(total)}</Text>
                </View>
              </View>

              {invoice.caseNotes ? (
                <View style={s.notesSection}>
                  <Text style={s.notesLabel}>NOTES</Text>
                  <Text style={s.notesText}>{invoice.caseNotes}</Text>
                </View>
              ) : null}

              <View style={s.footer}>
                <View style={s.footerDivider} />
                <Text style={s.footerText}>Thank you for your business</Text>
                <Text style={s.footerSub}>Payment due within 30 days of invoice date</Text>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
  },
  scroll: {
    flex: 1,
  },
  paper: {
    margin: 16,
    backgroundColor: "#FFF",
    borderRadius: 12,
    overflow: "hidden",
    ...Platform.select({
      web: { boxShadow: "0 4px 24px rgba(0,0,0,0.08)" },
      default: {},
    }),
  },
  paperTopStripe: {
    height: 6,
    backgroundColor: "#2563EB",
  },
  paperContent: {
    padding: 20,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  labName: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
    marginBottom: 2,
  },
  labDetail: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#64748B",
    lineHeight: 16,
  },
  invoiceBadgeCol: {
    alignItems: "flex-end",
  },
  invoiceLabel: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: "#2563EB",
    letterSpacing: 2,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    marginTop: 6,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusPillText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: "#E2E8F0",
    marginVertical: 16,
  },
  metaRow: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 16,
  },
  metaCol: {
    flex: 1,
  },
  metaLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: "#94A3B8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  metaValue: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#1E293B",
  },
  billToSection: {
    flexDirection: "row",
    gap: 20,
    marginBottom: 16,
    backgroundColor: "#F8FAFC",
    padding: 14,
    borderRadius: 10,
  },
  billToCol: {
    flex: 1,
  },
  billToLabel: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#94A3B8",
    letterSpacing: 1,
    marginBottom: 4,
  },
  billToName: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
    marginBottom: 2,
  },
  billToDetail: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748B",
  },
  caseInfoBar: {
    flexDirection: "row",
    backgroundColor: "#EFF6FF",
    borderRadius: 10,
    padding: 12,
    marginBottom: 20,
    alignItems: "center",
  },
  caseInfoItem: {
    flex: 1,
    alignItems: "center",
  },
  caseInfoDivider: {
    width: 1,
    height: 28,
    backgroundColor: "#BFDBFE",
  },
  caseInfoLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: "#3B82F6",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  caseInfoValue: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: "#1E40AF",
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#1E293B",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  tableHeaderText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  tableRowAlt: {
    backgroundColor: "#F8FAFC",
  },
  tableCell: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#334155",
  },
  tableCellBold: {
    fontFamily: "Inter_600SemiBold",
    color: "#1E293B",
  },
  colQty: {
    width: 32,
    textAlign: "center",
  },
  colItem: {
    width: 80,
    paddingRight: 6,
  },
  colDesc: {
    flex: 1,
    paddingRight: 6,
  },
  colRate: {
    width: 60,
    textAlign: "right",
    paddingRight: 6,
  },
  colAmount: {
    width: 65,
    textAlign: "right",
  },
  totalsSection: {
    marginTop: 16,
    alignSelf: "flex-end",
    width: "55%",
    minWidth: 180,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
  },
  totalLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "#64748B",
  },
  totalValue: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#1E293B",
  },
  totalDivider: {
    height: 1,
    backgroundColor: "#E2E8F0",
    marginVertical: 6,
  },
  grandTotalRow: {
    paddingVertical: 8,
  },
  grandTotalLabel: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
  },
  grandTotalValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#2563EB",
  },
  notesSection: {
    marginTop: 20,
    padding: 14,
    backgroundColor: "#FFFBEB",
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: "#F59E0B",
  },
  notesLabel: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#92400E",
    letterSpacing: 1,
    marginBottom: 4,
  },
  notesText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#78350F",
    lineHeight: 18,
  },
  footer: {
    marginTop: 24,
    alignItems: "center",
  },
  footerDivider: {
    width: "60%",
    height: 1,
    backgroundColor: "#E2E8F0",
    marginBottom: 12,
  },
  footerText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748B",
  },
  footerSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#94A3B8",
    marginTop: 2,
  },
});
