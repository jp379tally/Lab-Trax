import { describe, expect, it } from "vitest";
import { filterAndSortInvoices } from "@workspace/api-client-react";
import {
  INVOICE_FILTER_PARITY_CASES,
  INVOICE_FILTER_PARITY_NOW,
  INVOICE_FILTER_PARITY_ROWS,
} from "@workspace/api-client-react/invoice-filter-test-fixtures";

describe("desktop invoice filter parity", () => {
  it.each(INVOICE_FILTER_PARITY_CASES)("$name", ({ options, expectedIds }) => {
    expect(
      filterAndSortInvoices(
        INVOICE_FILTER_PARITY_ROWS,
        options,
        INVOICE_FILTER_PARITY_NOW,
      ).map((invoice) => invoice.id),
    ).toEqual(expectedIds);
  });
});