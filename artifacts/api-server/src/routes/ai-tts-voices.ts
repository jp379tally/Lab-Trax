/**
 * Canonical OpenAI TTS voice catalogue.
 *
 * Voice IDs are the strings accepted by the OpenAI audio modality API.
 * Display labels pair each voice with a user-reported gender-presentation
 * hint. OpenAI does not officially assign genders; these are community
 * descriptions only — the disclaimer is surfaced to users in the picker UI.
 */

export const TTS_VOICE_IDS = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

export type TtsVoiceId = (typeof TTS_VOICE_IDS)[number];

export interface TtsVoiceEntry {
  value: TtsVoiceId;
  /** Short human-readable label shown in the picker. */
  label: string;
  /** User-reported gender-presentation hint (NOT an official OpenAI classification). */
  hint: string;
}

export const TTS_VOICES: TtsVoiceEntry[] = [
  { value: "alloy",   label: "Alloy (Neutral 1)",    hint: "Neutral" },
  { value: "ash",     label: "Ash (Masculine 1)",    hint: "Masculine" },
  { value: "ballad",  label: "Ballad (Masculine 2)", hint: "Masculine" },
  { value: "coral",   label: "Coral (Feminine 1)",   hint: "Feminine" },
  { value: "echo",    label: "Echo (Neutral 2)",     hint: "Neutral" },
  { value: "sage",    label: "Sage (Feminine 2)",    hint: "Feminine" },
  { value: "shimmer", label: "Shimmer (Feminine 3)", hint: "Feminine" },
  { value: "verse",   label: "Verse (Neutral 3)",    hint: "Neutral" },
];

/** Default voice for new users on both desktop and mobile. */
export const TTS_DEFAULT_VOICE: TtsVoiceId = "alloy";
