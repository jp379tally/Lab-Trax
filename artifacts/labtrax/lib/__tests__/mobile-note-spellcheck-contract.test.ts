import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

function inputWithTestId(relativePath: string, testId: string): string {
  const contents = source(relativePath);
  const input = contents
    .match(
      new RegExp(
        `<TextInput(?:(?!<TextInput)[\\s\\S])*?testID=["'\`]${testId}["'\`](?:(?!<TextInput)[\\s\\S])*?\\/>`,
        "g",
      ),
    )
    ?.at(-1);

  expect(input, `${relativePath} should contain ${testId}`).toBeDefined();
  return input!;
}

function expectNativeWritingAssistance(input: string): void {
  expect(input).toContain("autoCorrect={true}");
  expect(input).toContain("spellCheck={true}");
  expect(input).toContain('autoCapitalize="sentences"');
}

describe("mobile note spelling assistance contract", () => {
  it.each([
    ["app/new-case.tsx", "new-case-notes"],
    ["app/case/[id].tsx", "note-input"],
    ["components/CaseQuickActionSheet.tsx", "case-quick-note-input"],
    ["app/messages/[threadId].tsx", "message-input"],
    ["app/invoice-editor/[id].tsx", "invoice-editor-notes"],
    ["app/settings/report-issue.tsx", "report-issue-description"],
  ])("enables native writing assistance for %s#%s", (relativePath, testId) => {
    expectNativeWritingAssistance(inputWithTestId(relativePath, testId));
  });

  it("keeps structured inputs free of prose keyboard settings", () => {
    const barcodeInput = inputWithTestId("app/new-case.tsx", "new-case-barcode");
    expect(barcodeInput).not.toContain("spellCheck={true}");
    expect(barcodeInput).not.toContain('autoCapitalize="sentences"');

    const invoiceNumberInput = inputWithTestId(
      "app/invoice-editor/[id].tsx",
      "invoice-editor-number",
    );
    expect(invoiceNumberInput).not.toContain("spellCheck={true}");
    expect(invoiceNumberInput).not.toContain('autoCapitalize="sentences"');
  });

  it("covers finance memos and receipt messages without changing amount fields", () => {
    const payBills = source("app/finance/pay-bills.tsx");
    expect(payBills).toMatch(
      /testID="pay-bills-memo"[^>]*autoCorrect=\{true\}[^>]*spellCheck=\{true\}[^>]*autoCapitalize="sentences"/,
    );

    const receivePayments = source("app/finance/receive-payments.tsx");
    expect(receivePayments).toContain('testID="receipt-body" multiline prose');
    expect(receivePayments).toContain('testID="receive-memo" prose');
    const amountInputStart = receivePayments.indexOf(
      "testID={`receive-invoice-amount-${invoice.id}`}",
    );
    expect(amountInputStart).toBeGreaterThan(-1);
    expect(receivePayments.slice(amountInputStart, amountInputStart + 500)).toContain(
      'keyboardType="decimal-pad"',
    );
  });
});