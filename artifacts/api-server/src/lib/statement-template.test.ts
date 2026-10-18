import { describe, expect, it } from "vitest";
import {
  coerceStatementTemplate,
  DEFAULT_STATEMENT_TEMPLATE,
  statementTemplateSchema,
} from "./statement-template";

describe("statement section registry", () => {
  it("synthesizes stable generated sections from legacy boxes", () => {
    const legacy = {
      ...DEFAULT_STATEMENT_TEMPLATE,
      sections: undefined,
      boxes: {
        ...DEFAULT_STATEMENT_TEMPLATE.boxes,
        totals: { x: 350, y: 610, w: 200, h: 80 },
      },
    };

    const template = coerceStatementTemplate(legacy);

    expect(template.sections).toHaveLength(8);
    expect(template.sections.map((section) => section.id)).toEqual([
      "stmtHeader",
      "labInfo",
      "practiceInfo",
      "balanceSummary",
      "transactions",
      "aging",
      "totals",
      "footer",
    ]);
    expect(template.sections.find((section) => section.generatedType === "totals")?.box)
      .toEqual(legacy.boxes.totals);
  });

  it("preserves disabled, renamed, custom, copied, and removed sections", () => {
    const base = coerceStatementTemplate(null);
    const parsed = statementTemplateSchema.parse({
      ...base,
      sections: [
        { ...base.sections[0], enabled: false, title: "Account statement" },
        {
          ...base.sections[1],
          id: "lab-info-copy",
          title: "Second lab address",
          box: { x: 40, y: 200, w: 240, h: 80 },
        },
        {
          id: "custom-message",
          type: "custom",
          title: "A note from the lab",
          enabled: true,
          contentMode: "custom",
          customText: "Thank you for your business.",
          box: { x: 300, y: 200, w: 250, h: 80 },
        },
      ],
    });

    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections[0]).toMatchObject({ enabled: false, title: "Account statement" });
    expect(parsed.sections[1]).toMatchObject({ id: "lab-info-copy", generatedType: "labInfo" });
    expect(parsed.sections[2]).toMatchObject({ type: "custom", contentMode: "custom" });
  });

  it("rejects section limits, unsupported types, long content, and out-of-page geometry", () => {
    const base = coerceStatementTemplate(null);
    const section = base.sections[0];
    expect(statementTemplateSchema.safeParse({
      ...base,
      sections: Array.from({ length: 41 }, (_, index) => ({ ...section, id: `section-${index}` })),
    }).success).toBe(false);
    expect(statementTemplateSchema.safeParse({
      ...base,
      sections: [{ ...section, title: "x".repeat(121) }],
    }).success).toBe(false);
    expect(statementTemplateSchema.safeParse({
      ...base,
      sections: [{ ...section, contentMode: "custom", customText: "x".repeat(4001) }],
    }).success).toBe(false);
    expect(statementTemplateSchema.safeParse({
      ...base,
      sections: [{ ...section, generatedType: "unsupported" }],
    }).success).toBe(false);
    expect(statementTemplateSchema.safeParse({
      ...base,
      sections: [{ ...section, box: { x: 580, y: 30, w: 100, h: 50 } }],
    }).success).toBe(false);
  });

  it("keeps legacy short transaction boxes valid when synthesizing sections", () => {
    const legacy = {
      ...DEFAULT_STATEMENT_TEMPLATE,
      sections: undefined,
      boxes: {
        ...DEFAULT_STATEMENT_TEMPLATE.boxes,
        transactions: { x: 40, y: 260, w: 532, h: 10 },
      },
    };

    const parsed = statementTemplateSchema.parse(legacy);
    expect(parsed.sections.find((item) => item.generatedType === "transactions")?.box.h).toBe(10);
    expect(statementTemplateSchema.safeParse(parsed).success).toBe(true);
  });
});