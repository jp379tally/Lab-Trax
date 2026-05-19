import React, { useState, useEffect, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import type { Invoice, InvoiceLineItem } from "@/lib/data";
import { formatInvNum } from "@/lib/data";

export const PRICE_LIST_ITEMS = [
  { key: "zirconia_crown", label: "Zirconia Crown" },
  { key: "emax_crown", label: "Emax Crown" },
  { key: "pfm_crown", label: "PFM Crown" },
  { key: "pfz_crown", label: "PFZ Crown" },
  { key: "denture", label: "Denture" },
  { key: "partial", label: "Partial" },
  { key: "flipper", label: "Flipper" },
  { key: "implant", label: "Implant" },
  { key: "night_guard", label: "Night Guard" },
  { key: "temporary", label: "Temporary" },
  { key: "essix", label: "Essix" },
] as const;

interface DoctorPricingItem {
  key: string;
  label: string;
  price: number;
}

interface InvoicePDFViewerProps {
  visible: boolean;
  onClose: () => void;
  invoice: Invoice | null;
  editable?: boolean;
  onSave?: (updatedInvoice: Invoice) => void;
  doctorPricing?: Record<string, number>;
  companyLogo?: string | null;
  labName?: string;
  labAddress?: string;
  labPhone?: string;
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

export default function InvoicePDFViewer({ visible, onClose, invoice, editable = false, onSave, doctorPricing, companyLogo, labName, labAddress, labPhone }: InvoicePDFViewerProps) {
  const insets = useSafeAreaInsets();
  const [editMode, setEditMode] = useState(false);
  const [editLineItems, setEditLineItems] = useState<InvoiceLineItem[]>([]);
  const [editCredits, setEditCredits] = useState(0);
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemDesc, setNewItemDesc] = useState("");
  const [newItemQty, setNewItemQty] = useState("1");
  const [newItemRate, setNewItemRate] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountIdx, setDiscountIdx] = useState<number | null>(null);
  const [discountType, setDiscountType] = useState<"percent" | "flat">("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const [editBillTo, setEditBillTo] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editInvoiceNotes, setEditInvoiceNotes] = useState("");

  useEffect(() => {
    if (invoice && visible) {
      setEditLineItems(invoice.lineItems.map(li => ({ ...li })));
      setEditCredits(invoice.credits || 0);
      setEditBillTo(invoice.billTo || "");
      setEditNotes(invoice.caseNotes || "");
      setEditInvoiceNotes(invoice.notes || "");
      setEditMode(false);
      setHasChanges(false);
      setShowAddItem(false);
      setShowDiscount(false);
      setEditingIdx(null);
      setDiscountIdx(null);
      setNewItemName("");
      setNewItemDesc("");
      setNewItemQty("1");
      setNewItemRate("");
      setDiscountValue("");
    }
  }, [invoice?.id, visible]);

  const pricedItems: DoctorPricingItem[] = useMemo(() => {
    if (!doctorPricing) return [];
    return PRICE_LIST_ITEMS
      .filter(item => doctorPricing[item.key] !== undefined && doctorPricing[item.key] > 0)
      .map(item => ({ key: item.key, label: item.label, price: doctorPricing[item.key] }));
  }, [doctorPricing]);

  if (!invoice) return null;

  const displayItems = editMode ? editLineItems : invoice.lineItems;
  const subtotal = displayItems.reduce((sum, li) => sum + li.amount, 0);
  const credits = editMode ? editCredits : (invoice.credits || 0);
  const total = subtotal - credits;

  const teethDisplay = invoice.teeth || "";

  function handleSelectPricedItem(item: DoctorPricingItem) {
    setNewItemName(item.label);
    setNewItemRate(item.price.toString());
    const desc = teethDisplay ? `${item.label} - tooth ${teethDisplay}` : item.label;
    setNewItemDesc(desc);
    setShowItemDropdown(false);
  }

  function handleItemNameChange(text: string) {
    setNewItemName(text);
    setShowItemDropdown(false);
    if (!text.trim() || pricedItems.length === 0) return;
    const lower = text.trim().toLowerCase();
    const match = pricedItems.find(
      (item) => item.label.toLowerCase().startsWith(lower) || item.label.toLowerCase().includes(lower)
    );
    if (match) {
      setNewItemRate(match.price.toString());
      const desc = teethDisplay ? `${match.label} - tooth ${teethDisplay}` : match.label;
      setNewItemDesc(desc);
    }
  }

  const statusColor =
    invoice.status === "paid" ? "#10B981" :
    invoice.status === "overdue" ? "#EF4444" :
    invoice.status === "sent" ? "#3B82F6" :
    "#F59E0B";

  function handleEditItem(idx: number) {
    setEditingIdx(idx);
    const li = editLineItems[idx];
    setNewItemName(li.item);
    setNewItemDesc(li.description);
    setNewItemQty(li.qty.toString());
    setNewItemRate(li.rate.toString());
    setShowAddItem(true);
  }

  function handleSaveItem() {
    const qty = Math.max(1, Math.round(parseInt(newItemQty) || 1));
    const rate = Math.max(0, parseFloat(newItemRate) || 0);
    if (rate === 0) {
      Alert.alert("Invalid Rate", "Please enter a rate greater than zero.");
      return;
    }
    const item: InvoiceLineItem = {
      qty,
      item: newItemName.trim() || "Item",
      description: newItemDesc.trim(),
      rate,
      amount: qty * rate,
    };

    if (editingIdx !== null) {
      const updated = [...editLineItems];
      updated[editingIdx] = item;
      setEditLineItems(updated);
    } else {
      setEditLineItems([...editLineItems, item]);
    }

    setHasChanges(true);
    resetItemForm();
  }

  function resetItemForm() {
    setShowAddItem(false);
    setEditingIdx(null);
    setNewItemName("");
    setNewItemDesc("");
    setNewItemQty("1");
    setNewItemRate("");
    setShowItemDropdown(false);
  }

  function handleRemoveItem(idx: number) {
    Alert.alert("Remove Item", `Remove "${editLineItems[idx].item}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          setEditLineItems(editLineItems.filter((_, i) => i !== idx));
          setHasChanges(true);
        },
      },
    ]);
  }

  function handleOpenDiscount(idx: number) {
    setDiscountIdx(idx);
    setDiscountType("percent");
    setDiscountValue("");
    setShowDiscount(true);
  }

  function handleApplyDiscount() {
    if (discountIdx === null) return;
    const val = Math.max(0, parseFloat(discountValue) || 0);
    if (val === 0) {
      Alert.alert("Invalid Discount", "Please enter a discount value greater than zero.");
      return;
    }
    const updated = [...editLineItems];
    const li = updated[discountIdx];
    const fullPrice = li.qty * li.rate;

    if (discountType === "percent") {
      const clampedPct = Math.min(100, val);
      const discountAmt = fullPrice * (clampedPct / 100);
      updated[discountIdx] = {
        ...li,
        amount: Math.max(0, fullPrice - discountAmt),
        description: li.description + ` (${clampedPct}% discount)`,
      };
    } else {
      const clampedFlat = Math.min(fullPrice, val);
      updated[discountIdx] = {
        ...li,
        amount: Math.max(0, fullPrice - clampedFlat),
        description: li.description + ` ($${clampedFlat} discount)`,
      };
    }

    setEditLineItems(updated);
    setHasChanges(true);
    setShowDiscount(false);
    setDiscountIdx(null);
  }

  function handleSaveAll() {
    if (!onSave || !invoice) return;
    const newTotal = editLineItems.reduce((s, li) => s + li.amount, 0);
    onSave({
      ...invoice,
      lineItems: editLineItems,
      amount: newTotal,
      credits: editCredits,
      billTo: editBillTo.trim() || invoice.billTo,
      caseNotes: editNotes,
      notes: editInvoiceNotes,
    });
    setEditMode(false);
    setHasChanges(false);
    Alert.alert("Saved", "Invoice updated successfully.");
  }

  function buildInvoiceHtml(): string {
    if (!invoice) return "";
    const items = invoice.lineItems || [];
    const sub = items.reduce((s, li) => s + li.amount, 0);
    const cr = invoice.credits || 0;
    const tot = sub - cr;
    const esc = (v: unknown) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const rows = items
      .map(
        (li) => `
          <tr>
            <td style="padding:10px 8px;border-bottom:1px solid #E5E7EB;text-align:center;width:50px;">${esc(li.qty)}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #E5E7EB;">
              <div style="font-weight:600;color:#0F172A;">${esc(li.item)}</div>
              ${li.description ? `<div style="font-size:11px;color:#64748B;margin-top:2px;">${esc(li.description)}</div>` : ""}
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #E5E7EB;text-align:right;width:90px;color:#334155;">${formatCurrency(li.rate)}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #E5E7EB;text-align:right;width:100px;font-weight:600;color:#0F172A;">${formatCurrency(li.amount)}</td>
          </tr>`,
      )
      .join("");
    const logoHtml = companyLogo
      ? `<img src="${esc(companyLogo)}" style="max-width:140px;max-height:60px;object-fit:contain;" />`
      : `<div style="font-size:22px;font-weight:700;color:#0F172A;">${esc(labName || "LabTrax")}</div>`;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Invoice ${esc(formatInvNum(invoice.invoiceNumber))}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#0F172A; margin:0; padding:32px; }
  .stripe { height:6px; background:#2563EB; border-radius:3px; margin-bottom:24px; }
  .row { display:flex; justify-content:space-between; align-items:flex-start; }
  .muted { color:#64748B; font-size:12px; }
  table { width:100%; border-collapse:collapse; margin-top:16px; }
  th { text-align:left; padding:8px; background:#F1F5F9; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#475569; }
  th.right { text-align:right; }
  th.center { text-align:center; }
  .totals { margin-top:16px; margin-left:auto; width:280px; }
  .totals .line { display:flex; justify-content:space-between; padding:6px 0; }
  .totals .grand { border-top:2px solid #0F172A; margin-top:6px; padding-top:10px; font-size:16px; font-weight:700; }
  .notes { margin-top:24px; padding:12px; background:#F8FAFC; border-left:3px solid #2563EB; font-size:12px; color:#334155; white-space:pre-wrap; }
</style></head>
<body>
  <div class="stripe"></div>
  <div class="row">
    <div>
      ${logoHtml}
      ${labAddress ? `<div class="muted" style="margin-top:8px;">${esc(labAddress)}</div>` : ""}
      ${labPhone ? `<div class="muted">${esc(labPhone)}</div>` : ""}
    </div>
    <div style="text-align:right;">
      <div style="font-size:28px;font-weight:700;letter-spacing:1px;">INVOICE</div>
      <div class="muted" style="margin-top:4px;">#${esc(formatInvNum(invoice.invoiceNumber))}</div>
      <div class="muted">${esc(formatDate(invoice.issuedAt))}</div>
    </div>
  </div>

  <div class="row" style="margin-top:24px;">
    <div style="max-width:55%;">
      <div class="muted" style="text-transform:uppercase;letter-spacing:0.5px;">Bill To</div>
      <div style="margin-top:4px;font-weight:600;white-space:pre-wrap;">${esc(invoice.billTo || "")}</div>
    </div>
    <div style="text-align:right;">
      <div class="muted" style="text-transform:uppercase;letter-spacing:0.5px;">Patient</div>
      <div style="margin-top:4px;font-weight:600;">${esc(invoice.patientName || "")}</div>
      ${invoice.teeth ? `<div class="muted" style="margin-top:6px;">Tooth ${esc(invoice.teeth)}</div>` : ""}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="center" style="width:50px;">Qty</th>
        <th>Item</th>
        <th class="right" style="width:90px;">Rate</th>
        <th class="right" style="width:100px;">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="line"><span class="muted">Subtotal</span><span>${formatCurrency(sub)}</span></div>
    ${cr > 0 ? `<div class="line"><span class="muted">Credits</span><span>-${formatCurrency(cr)}</span></div>` : ""}
    <div class="line grand"><span>Total</span><span>${formatCurrency(tot)}</span></div>
  </div>

  ${invoice.caseNotes ? `<div class="notes"><strong>Notes:</strong>\n${esc(invoice.caseNotes)}</div>` : ""}
  ${invoice.notes ? `<div class="notes"><strong>Invoice Notes:</strong>\n${esc(invoice.notes)}</div>` : ""}
</body></html>`;
  }

  async function handlePrint() {
    if (!invoice) return;
    if (editMode && hasChanges) {
      Alert.alert("Save First", "Please save your changes before printing.");
      return;
    }
    try {
      const html = buildInvoiceHtml();
      if (Platform.OS === "web") {
        await Print.printAsync({ html });
      } else {
        const { uri } = await Print.printToFileAsync({ html, base64: false });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, {
            mimeType: "application/pdf",
            UTI: "com.adobe.pdf",
            dialogTitle: `Invoice ${formatInvNum(invoice.invoiceNumber)}`,
          });
        } else {
          await Print.printAsync({ uri });
        }
      }
    } catch (err) {
      console.warn("[InvoicePDFViewer] print error", err);
      Alert.alert("Print Failed", "Could not generate the PDF. Please try again.");
    }
  }

  function handleCancelEdit() {
    if (hasChanges) {
      Alert.alert("Discard Changes?", "You have unsaved changes.", [
        { text: "Keep Editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            if (!invoice) return;
            setEditLineItems(invoice.lineItems.map(li => ({ ...li })));
            setEditCredits(invoice.credits || 0);
            setEditBillTo(invoice.billTo || "");
            setEditNotes(invoice.caseNotes || "");
            setEditInvoiceNotes(invoice.notes || "");
            setEditMode(false);
            setHasChanges(false);
          },
        },
      ]);
    } else {
      setEditMode(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[s.container, { paddingTop: Platform.OS === "web" ? 67 : insets.top }]}>
          <View style={s.header}>
            <Pressable onPress={() => { if (editMode && hasChanges) { handleCancelEdit(); } else { onClose(); } }} style={s.closeBtn}>
              <Ionicons name="arrow-back" size={22} color="#1E293B" />
            </Pressable>
            <Text style={s.headerTitle}>{editMode ? "Edit Invoice" : "Invoice"}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {!editMode && (
                <Pressable
                  onPress={handlePrint}
                  style={s.editBtn}
                  testID="invoice-print-btn"
                >
                  <Ionicons name="print-outline" size={18} color="#2563EB" />
                  <Text style={s.editBtnText}>Print</Text>
                </Pressable>
              )}
              {editable && !editMode ? (
                <Pressable
                  onPress={() => setEditMode(true)}
                  style={s.editBtn}
                >
                  <Ionicons name="create-outline" size={18} color="#2563EB" />
                  <Text style={s.editBtnText}>Edit</Text>
                </Pressable>
              ) : editMode ? (
                <Pressable onPress={handleCancelEdit} style={s.editBtn}>
                  <Ionicons name="close" size={18} color="#EF4444" />
                  <Text style={[s.editBtnText, { color: "#EF4444" }]}>Cancel</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          <ScrollView
            style={s.scroll}
            contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 34 + 20 : insets.bottom + 20 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <View style={s.paper}>
              <View style={s.paperTopStripe} />

              <View style={s.paperContent}>
                {/* Header: Logo/Company + Invoice title */}
                <View style={s.topRow}>
                  <View style={s.topRowLeft}>
                    {companyLogo ? (
                      <Image
                        source={{ uri: companyLogo }}
                        style={s.companyLogo}
                        contentFit="contain"
                      />
                    ) : null}
                    <View style={companyLogo ? s.labInfoWithLogo : undefined}>
                      <Text style={s.labName}>{labName || "LabTrax"}</Text>
                      {labAddress ? <Text style={s.labDetail}>{labAddress}</Text> : null}
                      {labPhone ? <Text style={s.labDetail}>{labPhone}</Text> : null}
                    </View>
                  </View>
                  <View style={s.invoiceBadgeCol}>
                    <Text style={s.invoiceLabel}>INVOICE</Text>
                    <Text style={s.invoiceNumber}>{formatInvNum(invoice.invoiceNumber)}</Text>
                    <View style={[s.statusPill, { backgroundColor: statusColor + "18" }]}>
                      <View style={[s.statusDot, { backgroundColor: statusColor }]} />
                      <Text style={[s.statusPillText, { color: statusColor }]}>
                        {invoice.status.toUpperCase()}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={s.divider} />

                {/* Dates row */}
                <View style={s.datesRow}>
                  <View style={s.dateItem}>
                    <Text style={s.dateLabel}>Issue Date</Text>
                    <Text style={s.dateValue}>{formatDate(invoice.issuedAt)}</Text>
                  </View>
                  <View style={s.dateItem}>
                    <Text style={s.dateLabel}>Due Date</Text>
                    <Text style={s.dateValue}>{formatDate(invoice.dueAt)}</Text>
                  </View>
                </View>

                {/* Bill To / Patient */}
                <View style={s.billToSection}>
                  <View style={[s.billToCol, { flex: 1.2 }]}>
                    <Text style={s.billToLabel}>BILL TO</Text>
                    {editMode ? (
                      <TextInput
                        style={[s.billToName, { borderBottomWidth: 1, borderBottomColor: "#3B82F6", paddingVertical: 4, minWidth: 120 }]}
                        value={editBillTo}
                        onChangeText={(v) => { setEditBillTo(v); setHasChanges(true); }}
                        placeholder="Provider name"
                        placeholderTextColor="#94A3B8"
                      />
                    ) : (
                      <Text style={s.billToName} numberOfLines={2}>{invoice.billTo}</Text>
                    )}
                    <Text style={s.billToDetail}>{invoice.clientName}</Text>
                  </View>
                  <View style={s.billToDivider} />
                  <View style={[s.billToCol, { flex: 0.8 }]}>
                    <Text style={s.billToLabel}>PATIENT</Text>
                    <Text style={s.billToName}>{invoice.patientName}</Text>
                  </View>
                </View>

                {/* Case details */}
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

                {/* Line items table - simplified columns */}
                <View style={s.tableHeader}>
                  <Text style={[s.tableHeaderText, s.colItem2]}>ITEM</Text>
                  <Text style={[s.tableHeaderText, s.colQty2]}>QTY</Text>
                  <Text style={[s.tableHeaderText, s.colRate2]}>RATE</Text>
                  <Text style={[s.tableHeaderText, s.colAmount2]}>AMOUNT</Text>
                  {editMode && <View style={{ width: 56 }} />}
                </View>

                {displayItems.map((li, idx) => (
                  <View key={idx} style={[s.tableRow, idx % 2 === 0 && s.tableRowAlt]}>
                    <View style={s.colItem2}>
                      <Text style={s.tableCellBold} numberOfLines={1}>
                        {li.toothNumber != null ? `#${li.toothNumber} ` : ""}{li.item}
                      </Text>
                      {li.description && li.description !== li.item ? (
                        <Text style={s.tableCellDesc} numberOfLines={1}>{li.description}</Text>
                      ) : null}
                    </View>
                    <Text style={[s.tableCell, s.colQty2]}>{li.qty}</Text>
                    <Text style={[s.tableCell, s.colRate2]}>{formatCurrency(li.rate)}</Text>
                    <Text style={[s.tableCell, s.colAmount2, s.tableCellBold]}>{formatCurrency(li.amount)}</Text>
                    {editMode && (
                      <View style={s.rowActions}>
                        <Pressable onPress={() => handleEditItem(idx)} hitSlop={8}>
                          <Ionicons name="pencil" size={14} color="#3B82F6" />
                        </Pressable>
                        <Pressable onPress={() => handleOpenDiscount(idx)} hitSlop={8}>
                          <Ionicons name="pricetag" size={14} color="#F59E0B" />
                        </Pressable>
                        <Pressable onPress={() => handleRemoveItem(idx)} hitSlop={8}>
                          <Ionicons name="trash" size={14} color="#EF4444" />
                        </Pressable>
                      </View>
                    )}
                  </View>
                ))}

                {editMode && (
                  <Pressable
                    onPress={() => { resetItemForm(); setShowAddItem(true); }}
                    style={s.addItemBtn}
                  >
                    <Ionicons name="add-circle" size={18} color="#2563EB" />
                    <Text style={s.addItemBtnText}>Add Line Item</Text>
                  </Pressable>
                )}

                {/* Totals */}
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

                {/* Notes */}
                {editMode ? (
                  <View style={s.notesSection}>
                    <Text style={s.notesLabel}>NOTES</Text>
                    <TextInput
                      style={[s.notesText, { borderWidth: 1, borderColor: "#3B82F6", borderRadius: 8, padding: 10, minHeight: 80, textAlignVertical: "top" }]}
                      value={editNotes}
                      onChangeText={(v) => { setEditNotes(v); setHasChanges(true); }}
                      placeholder="Add notes..."
                      placeholderTextColor="#94A3B8"
                      multiline
                    />
                  </View>
                ) : invoice.caseNotes ? (
                  <View style={s.notesSection}>
                    <Text style={s.notesLabel}>NOTES</Text>
                    <Text style={s.notesText}>{invoice.caseNotes}</Text>
                  </View>
                ) : null}

                {editMode ? (
                  <View style={s.notesSection}>
                    <Text style={s.notesLabel}>INVOICE NOTES</Text>
                    <TextInput
                      style={[s.notesText, { borderWidth: 1, borderColor: "#3B82F6", borderRadius: 8, padding: 10, minHeight: 80, textAlignVertical: "top" }]}
                      value={editInvoiceNotes}
                      onChangeText={(v) => { setEditInvoiceNotes(v); setHasChanges(true); }}
                      placeholder="Add invoice notes..."
                      placeholderTextColor="#94A3B8"
                      multiline
                    />
                  </View>
                ) : invoice.notes ? (
                  <View style={s.notesSection}>
                    <Text style={s.notesLabel}>INVOICE NOTES</Text>
                    <Text style={s.notesText}>{invoice.notes}</Text>
                  </View>
                ) : null}

                {/* Footer */}
                <View style={s.footer}>
                  <View style={s.footerDivider} />
                  <Text style={s.footerText}>Thank you for your business</Text>
                  <Text style={s.footerSub}>Payment due within 30 days of invoice date</Text>
                </View>
              </View>
            </View>

            {editMode && hasChanges && (
              <Pressable
                onPress={handleSaveAll}
                style={({ pressed }) => [s.saveBtn, pressed && { opacity: 0.85 }]}
              >
                <Ionicons name="checkmark-circle" size={20} color="#FFF" />
                <Text style={s.saveBtnText}>Save Changes</Text>
              </Pressable>
            )}
          </ScrollView>
        </View>

        <Modal visible={showAddItem} transparent animationType="fade">
          <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
            <Pressable style={s.modalOverlay} onPress={resetItemForm}>
              <Pressable style={s.modalCard} onPress={(e) => { e.stopPropagation(); setShowItemDropdown(false); }}>
                <Text style={s.modalTitle}>{editingIdx !== null ? "Edit Item" : "Add Item"}</Text>

                <Text style={s.fieldLabel}>Item Name</Text>
                <View>
                  <Pressable
                    style={s.dropdownTrigger}
                    onPress={() => pricedItems.length > 0 ? setShowItemDropdown(!showItemDropdown) : undefined}
                  >
                    <TextInput
                      style={[s.fieldInput, { flex: 1, marginBottom: 0 }]}
                      value={newItemName}
                      onChangeText={handleItemNameChange}
                      placeholder="e.g. Zirconia Crown"
                      placeholderTextColor="#94A3B8"
                    />
                    {pricedItems.length > 0 && (
                      <Pressable
                        onPress={() => setShowItemDropdown(!showItemDropdown)}
                        style={s.dropdownArrow}
                      >
                        <Ionicons name={showItemDropdown ? "chevron-up" : "chevron-down"} size={20} color="#64748B" />
                      </Pressable>
                    )}
                  </Pressable>
                  {showItemDropdown && pricedItems.length > 0 && (
                    <View style={s.dropdownList}>
                      <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {pricedItems.map((item) => (
                          <Pressable
                            key={item.key}
                            style={({ pressed }) => [s.dropdownItem, pressed && { backgroundColor: "#F1F5F9" }]}
                            onPress={() => handleSelectPricedItem(item)}
                          >
                            <Text style={s.dropdownItemLabel}>{item.label}</Text>
                            <Text style={s.dropdownItemPrice}>{formatCurrency(item.price)}</Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    </View>
                  )}
                </View>

                <Text style={s.fieldLabel}>Description</Text>
                <TextInput
                  style={s.fieldInput}
                  value={newItemDesc}
                  onChangeText={setNewItemDesc}
                  placeholder="e.g. Full contour zirconia - tooth #14"
                  placeholderTextColor="#94A3B8"
                />

                <View style={s.fieldRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.fieldLabel}>Qty</Text>
                    <TextInput
                      style={s.fieldInput}
                      value={newItemQty}
                      onChangeText={setNewItemQty}
                      keyboardType="number-pad"
                      placeholderTextColor="#94A3B8"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.fieldLabel}>Rate ($)</Text>
                    <TextInput
                      style={s.fieldInput}
                      value={newItemRate}
                      onChangeText={setNewItemRate}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      placeholderTextColor="#94A3B8"
                    />
                  </View>
                </View>

                {(newItemQty && newItemRate) ? (
                  <Text style={s.previewAmt}>
                    Amount: {formatCurrency((parseInt(newItemQty) || 0) * (parseFloat(newItemRate) || 0))}
                  </Text>
                ) : null}

                <View style={s.modalBtnRow}>
                  <Pressable onPress={resetItemForm} style={[s.modalBtn, s.modalBtnCancel]}>
                    <Text style={s.modalBtnCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleSaveItem}
                    style={[s.modalBtn, s.modalBtnSave]}
                  >
                    <Text style={s.modalBtnSaveText}>{editingIdx !== null ? "Update" : "Add"}</Text>
                  </Pressable>
                </View>
              </Pressable>
            </Pressable>
          </KeyboardAvoidingView>
        </Modal>

        <Modal visible={showDiscount} transparent animationType="fade">
          <Pressable style={s.modalOverlay} onPress={() => setShowDiscount(false)}>
            <Pressable style={s.modalCard} onPress={(e) => e.stopPropagation()}>
              <Text style={s.modalTitle}>Apply Discount</Text>
              {discountIdx !== null && (
                <Text style={s.discountItemName}>{editLineItems[discountIdx]?.item}</Text>
              )}

              <View style={s.discountToggle}>
                <Pressable
                  onPress={() => setDiscountType("percent")}
                  style={[s.discountToggleBtn, discountType === "percent" && s.discountToggleBtnActive]}
                >
                  <Text style={[s.discountToggleText, discountType === "percent" && s.discountToggleTextActive]}>% Percent</Text>
                </Pressable>
                <Pressable
                  onPress={() => setDiscountType("flat")}
                  style={[s.discountToggleBtn, discountType === "flat" && s.discountToggleBtnActive]}
                >
                  <Text style={[s.discountToggleText, discountType === "flat" && s.discountToggleTextActive]}>$ Flat</Text>
                </Pressable>
              </View>

              <TextInput
                style={s.fieldInput}
                value={discountValue}
                onChangeText={setDiscountValue}
                keyboardType="decimal-pad"
                placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 25.00"}
                placeholderTextColor="#94A3B8"
              />

              {discountIdx !== null && discountValue ? (
                <Text style={s.previewAmt}>
                  {discountType === "percent"
                    ? `Discount: ${formatCurrency(editLineItems[discountIdx].qty * editLineItems[discountIdx].rate * ((parseFloat(discountValue) || 0) / 100))} off`
                    : `Discount: ${formatCurrency(parseFloat(discountValue) || 0)} off`}
                </Text>
              ) : null}

              <View style={s.modalBtnRow}>
                <Pressable onPress={() => setShowDiscount(false)} style={[s.modalBtn, s.modalBtnCancel]}>
                  <Text style={s.modalBtnCancelText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={handleApplyDiscount} style={[s.modalBtn, s.modalBtnSave]}>
                  <Text style={s.modalBtnSaveText}>Apply</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </KeyboardAvoidingView>
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
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#EFF6FF",
  },
  editBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#2563EB",
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
  topRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 12,
  },
  companyLogo: {
    width: 48,
    height: 48,
    borderRadius: 8,
  },
  labInfoWithLogo: {
    flex: 1,
  },
  labName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
    marginBottom: 1,
  },
  labDetail: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#64748B",
    lineHeight: 16,
  },
  invoiceBadgeCol: {
    alignItems: "flex-end",
    marginLeft: 12,
  },
  invoiceLabel: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#2563EB",
    letterSpacing: 2,
  },
  invoiceNumber: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#64748B",
    marginTop: 2,
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
  datesRow: {
    flexDirection: "row",
    gap: 24,
    marginBottom: 16,
  },
  dateItem: {},
  dateLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: "#94A3B8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  dateValue: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#1E293B",
  },
  billToSection: {
    flexDirection: "row",
    marginBottom: 16,
    backgroundColor: "#F8FAFC",
    padding: 14,
    borderRadius: 10,
    alignItems: "flex-start",
  },
  billToCol: {},
  billToDivider: {
    width: 1,
    backgroundColor: "#E2E8F0",
    alignSelf: "stretch",
    marginHorizontal: 14,
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
    alignItems: "center",
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
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#1E293B",
  },
  tableCellDesc: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: "#94A3B8",
    marginTop: 1,
  },
  colItem2: {
    flex: 1,
    paddingRight: 8,
  },
  colQty2: {
    width: 36,
    textAlign: "center",
  },
  colRate2: {
    width: 64,
    textAlign: "right",
    paddingRight: 8,
  },
  colAmount2: {
    width: 72,
    textAlign: "right",
  },
  rowActions: {
    flexDirection: "row",
    gap: 10,
    width: 60,
    justifyContent: "flex-end",
    paddingLeft: 4,
  },
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderWidth: 1.5,
    borderColor: "#2563EB",
    borderStyle: "dashed",
    borderRadius: 8,
    marginTop: 8,
  },
  addItemBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#2563EB",
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
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 20,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: "#10B981",
  },
  saveBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#64748B",
    marginBottom: 4,
    marginTop: 8,
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#1E293B",
    backgroundColor: "#F8FAFC",
  },
  fieldRow: {
    flexDirection: "row",
    gap: 12,
  },
  previewAmt: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#2563EB",
    marginTop: 12,
    textAlign: "right",
  },
  modalBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  modalBtnCancel: {
    backgroundColor: "#F1F5F9",
  },
  modalBtnCancelText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#64748B",
  },
  modalBtnSave: {
    backgroundColor: "#2563EB",
  },
  modalBtnSaveText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  discountItemName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#1E293B",
    marginBottom: 12,
  },
  discountToggle: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 10,
    padding: 3,
    marginBottom: 12,
  },
  discountToggleBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  discountToggleBtnActive: {
    backgroundColor: "#FFF",
    ...Platform.select({
      web: { boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
      default: {},
    }),
  },
  discountToggleText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748B",
  },
  discountToggleTextActive: {
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
  },
  dropdownTrigger: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 0,
  },
  dropdownArrow: {
    position: "absolute" as const,
    right: 10,
    top: 10,
    padding: 4,
    zIndex: 1,
  },
  dropdownList: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    backgroundColor: "#FFF",
    marginTop: 4,
    marginBottom: 4,
    ...Platform.select({
      web: { boxShadow: "0 4px 12px rgba(0,0,0,0.12)" },
      default: {},
    }),
  },
  dropdownItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F0",
  },
  dropdownItemLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#1E293B",
  },
  dropdownItemPrice: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#2563EB",
  },
});
