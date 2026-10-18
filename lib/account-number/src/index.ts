/**
 * Shared platform account-number format.
 *
 * New numbers are twelve ASCII digits displayed as 4-4-4:
 *   7 + ten-digit permuted sequence payload + Luhn digit.
 *
 * This is deliberately a presentation permutation, not a security feature.
 * Generated numbers exclude adjacent 09 and 90 pairs, the only distinct-digit
 * adjacent transpositions ordinary Luhn cannot detect. Consequently every
 * non-identical adjacent swap of an issued number fails validation.
 */

export const ACCOUNT_NUMBER_VERSION = 7 as const;
export const ACCOUNT_NUMBER_PAYLOAD_DIGITS = 10 as const;
export const ACCOUNT_NUMBER_LENGTH = 12 as const;
// This prime domain covers every positive value allocatable by the existing
// PostgreSQL integer sequence column. Any non-zero multiplier permutes it.
export const ACCOUNT_NUMBER_MODULUS = 2_147_483_647n;
export const ACCOUNT_NUMBER_AFFINE_MULTIPLIER = 1_103_515_245n;
export const ACCOUNT_NUMBER_AFFINE_OFFSET = 1_234_567_891n;
export const ACCOUNT_NUMBER_NEW_INVALID = "new-invalid" as const;
export const ACCOUNT_NUMBER_NEW_VALID = "new-valid" as const;
export const ACCOUNT_NUMBER_LEGACY = "legacy" as const;
export const INVALID_ACCOUNT_NUMBER_MESSAGE =
  "That account number doesn't look right.";

export type AccountNumberClassification =
  | typeof ACCOUNT_NUMBER_NEW_VALID
  | typeof ACCOUNT_NUMBER_NEW_INVALID
  | typeof ACCOUNT_NUMBER_LEGACY;

function sequenceBigInt(sequence: bigint | number | string): bigint {
  if (typeof sequence === "number") {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError("Account-number sequence must be a non-negative safe integer.");
    }
    return BigInt(sequence);
  }
  let value: bigint;
  try {
    value = typeof sequence === "bigint" ? sequence : BigInt(sequence);
  } catch {
    throw new RangeError("Account-number sequence must be an integer.");
  }
  if (value < 0n) {
    throw new RangeError("Account-number sequence must be non-negative.");
  }
  return value;
}

function isLuhnBlindPair(left: number, right: number): boolean {
  return (left === 0 && right === 9) || (left === 9 && right === 0);
}

function luhnContribution(digit: number, doubled: boolean): number {
  if (!doubled) return digit;
  const value = digit * 2;
  return value > 9 ? value - 9 : value;
}

const safePayloadCountMemo = new Map<string, bigint>();

/**
 * Count safe completions of the ten-digit payload. The state includes the
 * partial Luhn sum so the final payload/check-digit boundary can also exclude
 * Luhn's 09/90 blind spot.
 */
function countSafePayloads(
  payloadPosition: number,
  previousDigit: number,
  sumModuloTen: number,
): bigint {
  if (payloadPosition === ACCOUNT_NUMBER_PAYLOAD_DIGITS) {
    const checkDigit = (10 - sumModuloTen) % 10;
    return isLuhnBlindPair(previousDigit, checkDigit) ? 0n : 1n;
  }
  const key = `${payloadPosition}:${previousDigit}:${sumModuloTen}`;
  const cached = safePayloadCountMemo.get(key);
  if (cached !== undefined) return cached;

  const bodyIndex = payloadPosition + 1;
  const doubled = bodyIndex % 2 === 0;
  let count = 0n;
  for (let digit = 0; digit <= 9; digit += 1) {
    if (isLuhnBlindPair(previousDigit, digit)) continue;
    count += countSafePayloads(
      payloadPosition + 1,
      digit,
      (sumModuloTen + luhnContribution(digit, doubled)) % 10,
    );
  }
  safePayloadCountMemo.set(key, count);
  return count;
}

function safePayloadAtRank(rank: bigint): string {
  let remainingRank = rank;
  let previousDigit: number = ACCOUNT_NUMBER_VERSION;
  let sumModuloTen = luhnContribution(ACCOUNT_NUMBER_VERSION, true) % 10;
  let payload = "";

  for (
    let payloadPosition = 0;
    payloadPosition < ACCOUNT_NUMBER_PAYLOAD_DIGITS;
    payloadPosition += 1
  ) {
    const bodyIndex = payloadPosition + 1;
    const doubled = bodyIndex % 2 === 0;
    let selected = false;
    for (let digit = 0; digit <= 9; digit += 1) {
      if (isLuhnBlindPair(previousDigit, digit)) continue;
      const nextSum =
        (sumModuloTen + luhnContribution(digit, doubled)) % 10;
      const completions = countSafePayloads(
        payloadPosition + 1,
        digit,
        nextSum,
      );
      if (remainingRank >= completions) {
        remainingRank -= completions;
        continue;
      }
      payload += String(digit);
      previousDigit = digit;
      sumModuloTen = nextSum;
      selected = true;
      break;
    }
    if (!selected) {
      throw new RangeError("Account-number rank exceeds the safe payload domain.");
    }
  }
  return payload;
}

function hasLuhnBlindPair(input: string): boolean {
  return input.includes("09") || input.includes("90");
}

/**
 * Remove spaces from an account-number input. Punctuation is intentionally
 * preserved so malformed identifiers cannot silently become valid numbers.
 */
export function normalizeAccountNumberInput(input: string): string {
  return input.replace(/ /g, "");
}

/** Alias retained for callers that use the shorter helper name. */
export const normalizeAccountNumber = normalizeAccountNumberInput;

/** Calculate the Luhn check digit for an 11-digit body. */
export function calculateLuhnCheckDigit(body: string): number {
  if (!/^\d+$/.test(body) || body.length === 0) {
    throw new RangeError("Luhn input must contain ASCII digits.");
  }
  let sum = 0;
  let double = true;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    let digit = body.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}
export const calculateLuhn = calculateLuhnCheckDigit;

export function isValidLuhn(input: string): boolean {
  if (!/^\d+$/.test(input) || input.length < 2) return false;
  let sum = 0;
  let double = false;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    let digit = input.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Alias used by some consumers. */
export const validateLuhn = isValidLuhn;

/**
 * Generate a new-format number from one value in the global allocation
 * sequence. The affine rank permutation prevents publishing the plain
 * increment, while safe-payload unranking excludes Luhn's transposition gap.
 */
export function generateAccountNumberFromSequence(
  sequence: bigint | number | string,
): string {
  const seq = sequenceBigInt(sequence);
  if (seq >= ACCOUNT_NUMBER_MODULUS) {
    throw new RangeError("Account-number sequence exceeds the ten-digit domain.");
  }
  const rank =
    (ACCOUNT_NUMBER_AFFINE_MULTIPLIER * seq + ACCOUNT_NUMBER_AFFINE_OFFSET) %
    ACCOUNT_NUMBER_MODULUS;
  const payload = safePayloadAtRank(rank);
  const body = `${ACCOUNT_NUMBER_VERSION}${payload}`;
  return `${body}${calculateLuhnCheckDigit(body)}`;
}

/** Short alias for generation from a sequence. */
export const generateFromSequence = generateAccountNumberFromSequence;
export const generatePlatformAccountNumber = generateAccountNumberFromSequence;

export function isValidNewAccountNumber(input: string): boolean {
  const normalized = normalizeAccountNumberInput(input);
  return (
    normalized.length === ACCOUNT_NUMBER_LENGTH &&
    normalized.charCodeAt(0) === 55 &&
    /^\d{12}$/.test(normalized) &&
    !hasLuhnBlindPair(normalized) &&
    isValidLuhn(normalized)
  );
}
export const validateNewAccountNumber = isValidNewAccountNumber;

/**
 * Classify a complete input. Every twelve-digit numeric value belongs to the
 * new format's input space, so a mistyped version digit is rejected along
 * with a bad Luhn digit. Historical formats contain letters or separators and
 * therefore remain legacy.
 */
export function classifyAccountNumber(
  input: string,
): AccountNumberClassification {
  const normalized = normalizeAccountNumberInput(input);
  if (/^\d{12}$/.test(normalized)) {
    return normalized.charCodeAt(0) === 55 &&
      !hasLuhnBlindPair(normalized) &&
      isValidLuhn(normalized)
      ? ACCOUNT_NUMBER_NEW_VALID
      : ACCOUNT_NUMBER_NEW_INVALID;
  }
  return ACCOUNT_NUMBER_LEGACY;
}
export const classifyPlatformAccountNumber = classifyAccountNumber;

/**
 * UI-friendly classification that carries the canonical lookup value for a
 * valid new number. Legacy identifiers retain their trimmed spelling.
 */
export function classifyAccountNumberInput(input: string): {
  kind: AccountNumberClassification;
  normalized: string;
} {
  const normalized = normalizeAccountNumberInput(input.trim());
  const kind = classifyAccountNumber(normalized);
  return { kind, normalized };
}

/** Display only valid new numbers with their 4-4-4 grouping. */
export function formatAccountNumberForDisplay(input: string): string {
  const normalized = normalizeAccountNumberInput(input);
  if (!isValidNewAccountNumber(normalized)) return input;
  return `${normalized.slice(0, 4)} ${normalized.slice(4, 8)} ${normalized.slice(8)}`;
}

/** Short alias for display formatting. */
export const formatAccountNumber = formatAccountNumberForDisplay;
export const displayAccountNumber = formatAccountNumberForDisplay;