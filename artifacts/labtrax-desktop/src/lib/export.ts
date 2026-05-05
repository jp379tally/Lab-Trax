import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export function downloadCsv(filename: string, rows: Array<Record<string, string | number | null | undefined>>) {
  if (rows.length === 0) {
    const blob = new Blob([""], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, filename);
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  const csv = lines.join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename);
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || "export";
}

export interface StatementPdfOptions {
  practiceName: string;
  generatedAt: Date;
  filtersDescription?: string;
  totals: {
    billed: number;
    paid: number;
    open: number;
    overdue: number;
  };
  invoices: Array<{
    invoiceNumber: string;
    issuedAt: string;
    dueAt: string;
    status: string;
    total: string;
    balanceDue: string;
  }>;
}

function fmtMoney(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(v);
}

export function downloadStatementPdf(opts: StatementPdfOptions) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;

  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Statement", margin, 50);

  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(opts.practiceName, margin, 70);

  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generated ${opts.generatedAt.toLocaleString("en-US")}`, margin, 86);
  if (opts.filtersDescription) {
    doc.text(opts.filtersDescription, margin, 100);
  }
  doc.setTextColor(0);

  const summaryY = opts.filtersDescription ? 124 : 110;
  const colWidth = (pageWidth - margin * 2) / 4;
  const summary: Array<[string, string]> = [
    ["Billed", fmtMoney(opts.totals.billed)],
    ["Paid", fmtMoney(opts.totals.paid)],
    ["Open balance", fmtMoney(opts.totals.open)],
    ["Overdue", fmtMoney(opts.totals.overdue)],
  ];
  summary.forEach(([label, value], i) => {
    const x = margin + colWidth * i;
    doc.setDrawColor(220);
    doc.setFillColor(248, 248, 250);
    doc.roundedRect(x, summaryY, colWidth - 8, 50, 4, 4, "FD");
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(label.toUpperCase(), x + 10, summaryY + 18);
    doc.setFontSize(13);
    doc.setTextColor(0);
    doc.setFont("helvetica", "bold");
    doc.text(value, x + 10, summaryY + 38);
    doc.setFont("helvetica", "normal");
  });

  autoTable(doc, {
    startY: summaryY + 70,
    head: [["Invoice", "Issued", "Due", "Status", "Total", "Open"]],
    body: opts.invoices.map((i) => [
      i.invoiceNumber,
      i.issuedAt,
      i.dueAt,
      i.status,
      fmtMoney(i.total),
      Number(i.balanceDue) > 0 ? fmtMoney(i.balanceDue) : "—",
    ]),
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: [40, 44, 52], textColor: 255 },
    columnStyles: {
      4: { halign: "right" },
      5: { halign: "right" },
    },
    margin: { left: margin, right: margin },
  });

  const filename = `statement-${safeFilename(opts.practiceName)}-${opts.generatedAt.toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}
