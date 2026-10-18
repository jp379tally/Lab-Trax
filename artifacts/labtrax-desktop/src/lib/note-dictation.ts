/**
 * Pure helpers for note-textarea speech dictation.
 *
 * Separating composition logic from the component lets us unit-test
 * the duplication-prevention invariant without a full React mount.
 */

export interface DictationResult {
  isFinal: boolean;
  transcript: string;
}

/**
 * Composes the new textarea value from a batch of SpeechRecognition results.
 *
 * @param newResults - Slice of results starting at `e.resultIndex` from the
 *   current `onresult` event (already converted to plain objects).
 * @param prevFinal - Running final transcript accumulated across all previous
 *   events in this dictation session (stored in a ref, not state).
 * @param base - The text that was in the textarea when dictation started
 *   (captured once into a ref on `startNoteListening`). Never mutated.
 * @returns `noteText` — the full textarea value to set, and `newFinal` — the
 *   updated running final transcript to store back in the ref.
 */
export function composeNoteDictation(
  newResults: DictationResult[],
  prevFinal: string,
  base: string,
): { noteText: string; newFinal: string } {
  let newFinal = prevFinal;
  let interim = "";
  for (const r of newResults) {
    if (r.isFinal) {
      newFinal += r.transcript;
    } else {
      interim = r.transcript;
    }
  }
  const dictated = (newFinal + interim).trim();
  const noteText = dictated ? (base ? base + " " + dictated : dictated) : base;
  return { noteText, newFinal };
}
