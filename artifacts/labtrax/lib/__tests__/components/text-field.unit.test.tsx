import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react-native";

import { TextField } from "@/components/ui/TextField";

afterEach(cleanup);

describe("TextField prose assistance", () => {
  it("enables native prose assistance for multiline fields", async () => {
    const { getByTestId } = await render(
      <TextField multiline testID="prose-field" value="" onChangeText={() => undefined} />,
    );
    const input = getByTestId("prose-field");

    expect(input.props.autoCorrect).toBe(true);
    expect(input.props.spellCheck).toBe(true);
    expect(input.props.autoCapitalize).toBe("sentences");
  });

  it("keeps explicit structured-field overrides", async () => {
    const { getByTestId } = await render(
      <TextField
        multiline
        testID="structured-field"
        value=""
        onChangeText={() => undefined}
        autoCorrect={false}
        spellCheck={false}
        autoCapitalize="none"
      />,
    );
    const input = getByTestId("structured-field");

    expect(input.props.autoCorrect).toBe(false);
    expect(input.props.spellCheck).toBe(false);
    expect(input.props.autoCapitalize).toBe("none");
  });

  it("leaves single-line defaults unchanged", async () => {
    const { getByTestId } = await render(
      <TextField testID="single-line-field" value="" onChangeText={() => undefined} />,
    );
    const input = getByTestId("single-line-field");

    expect(input.props.autoCorrect).toBeUndefined();
    expect(input.props.spellCheck).toBeUndefined();
    expect(input.props.autoCapitalize).toBeUndefined();
  });
});