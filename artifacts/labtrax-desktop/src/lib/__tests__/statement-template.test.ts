import { describe, expect, it } from "vitest";
import {
  coerceStatementTemplate,
  DEFAULT_STATEMENT_TEMPLATE,
} from "../statement-template";

describe("desktop statement template coercion", () => {
  it("synthesizes registry entries for old saved templates", () => {
    const template = coerceStatementTemplate({
      ...DEFAULT_STATEMENT_TEMPLATE,
      sections: undefined,
      boxes: {
        ...DEFAULT_STATEMENT_TEMPLATE.boxes,
        footer: { x: 45, y: 720, w: 500, h: 45 },
      },
    });

    expect(template.sections).toHaveLength(8);
    expect(template.sections.find((section) => section.generatedType === "footer")?.box)
      .toEqual({ x: 45, y: 720, w: 500, h: 45 });
  });

  it("keeps an intentionally empty registry and custom section values", () => {
    expect(coerceStatementTemplate({ ...DEFAULT_STATEMENT_TEMPLATE, sections: [] }).sections).toEqual([]);

    const custom = {
      id: "custom-1",
      type: "custom" as const,
      title: "Special instructions",
      enabled: false,
      contentMode: "custom" as const,
      customText: "Call before delivery.",
      box: { x: 40, y: 300, w: 250, h: 70 },
    };
    expect(coerceStatementTemplate({ ...DEFAULT_STATEMENT_TEMPLATE, sections: [custom] }).sections[0])
      .toEqual(custom);
  });
});