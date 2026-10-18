import { describe, it, expect } from "vitest";
import { composeNoteDictation, type DictationResult } from "../note-dictation";

function fin(transcript: string): DictationResult {
  return { isFinal: true, transcript };
}
function interim(transcript: string): DictationResult {
  return { isFinal: false, transcript };
}

describe("composeNoteDictation", () => {
  it("first interim result doesn't duplicate anything", () => {
    const { noteText, newFinal } = composeNoteDictation(
      [interim("when ")],
      "",
      "",
    );
    expect(noteText).toBe("when");
    expect(newFinal).toBe("");
  });

  it("repeated interim events with the same text don't accumulate", () => {
    let state = composeNoteDictation([interim("when ")], "", "");
    state = composeNoteDictation([interim("when whenever ")], state.newFinal, "");
    state = composeNoteDictation([interim("when whenever I ")], state.newFinal, "");
    expect(state.noteText).toBe("when whenever I");
    expect(state.newFinal).toBe("");
  });

  it("finalizing a result moves it to newFinal and resets interim", () => {
    let state = composeNoteDictation([interim("hello ")], "", "");
    state = composeNoteDictation([fin("hello ")], state.newFinal, "");
    expect(state.newFinal).toBe("hello ");
    expect(state.noteText).toBe("hello");
  });

  it("multiple interim events followed by final write clean output", () => {
    const base = "";
    let state = composeNoteDictation([interim("when ")], "", base);
    state = composeNoteDictation([interim("when whenever ")], state.newFinal, base);
    state = composeNoteDictation([interim("when whenever I ")], state.newFinal, base);
    state = composeNoteDictation([fin("when whenever I ")], state.newFinal, base);
    expect(state.noteText).toBe("when whenever I");
    expect(state.newFinal).toBe("when whenever I ");
  });

  it("preserves pre-existing base text and appends a single space", () => {
    const base = "Patient complaint:";
    const { noteText } = composeNoteDictation([interim("tooth pain")], "", base);
    expect(noteText).toBe("Patient complaint: tooth pain");
  });

  it("does not add a leading space when base is empty", () => {
    const { noteText } = composeNoteDictation([interim("hello")], "", "");
    expect(noteText).toBe("hello");
  });

  it("stopping and restarting dictation (new base) doesn't duplicate prior text", () => {
    const base1 = "";
    let s1 = composeNoteDictation([interim("first sentence")], "", base1);
    s1 = composeNoteDictation([fin("first sentence ")], s1.newFinal, base1);
    const firstResult = s1.noteText;

    const base2 = firstResult.trimEnd();
    let s2 = composeNoteDictation([interim("second sentence")], "", base2);
    s2 = composeNoteDictation([fin("second sentence ")], s2.newFinal, base2);

    expect(s2.noteText).toBe("first sentence second sentence");
  });

  it("returns base unchanged when dictated text is empty", () => {
    const { noteText, newFinal } = composeNoteDictation([], "", "existing text");
    expect(noteText).toBe("existing text");
    expect(newFinal).toBe("");
  });

  it("multiple consecutive final segments are concatenated without duplication", () => {
    const base = "";
    let state = composeNoteDictation([fin("one ")], "", base);
    state = composeNoteDictation([fin("two ")], state.newFinal, base);
    state = composeNoteDictation([fin("three ")], state.newFinal, base);
    expect(state.noteText).toBe("one two three");
    expect(state.newFinal).toBe("one two three ");
  });

  it("interim alongside accumulated final shows both without duplicating final", () => {
    const base = "";
    let state = composeNoteDictation([fin("hello ")], "", base);
    state = composeNoteDictation([interim("world")], state.newFinal, base);
    expect(state.noteText).toBe("hello world");
    expect(state.newFinal).toBe("hello ");
  });
});
