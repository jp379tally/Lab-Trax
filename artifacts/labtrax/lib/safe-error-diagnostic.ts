const SAFE_ERROR_TYPES = new Set([
  "Error",
  "EvalError",
  "Invariant Violation",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const COMPONENT_FRAME =
  /^\s*(?:in|at)\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/;
const MAX_COMPONENTS = 8;
const MAX_JS_FRAMES = 12;
const JS_BUNDLE_FRAME =
  /^\s*at\s+(?:async\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+\(.*\.(?:js)?bundle:(\d+):(\d+)\)\s*$/;
const SAFE_CALL_METHODS = new Set([
  "addListener",
  "apply",
  "bind",
  "call",
  "catch",
  "clear",
  "dispatch",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "getItem",
  "getState",
  "includes",
  "map",
  "navigate",
  "post",
  "push",
  "reduce",
  "refetch",
  "remove",
  "removeItem",
  "replace",
  "request",
  "setItem",
  "setOptions",
  "slice",
  "some",
  "sort",
  "startsWith",
  "then",
]);
const MEMBER_CALL_TARGET =
  /\b(?:[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)\s+is not a function\b/i;

function safeFailureDetail(errorType: string, errorMessage: unknown): string | null {
  if (
    errorType !== "TypeError" ||
    typeof errorMessage !== "string" ||
    !/\bis not a function\b|\bnot callable\b/i.test(errorMessage)
  ) {
    return null;
  }

  const memberCall = errorMessage.match(MEMBER_CALL_TARGET);
  if (!memberCall) return "direct_or_unknown_call";

  const methodName = memberCall[1];
  return SAFE_CALL_METHODS.has(methodName)
    ? `member_method:${methodName}`
    : "member_call";
}

function classifyFailurePattern(errorType: string, errorMessage: unknown): string {
  if (errorType !== "TypeError" || typeof errorMessage !== "string") {
    return "unclassified";
  }

  // Keep only broad, static categories. Never return message fragments, which
  // can contain account, case, or other user-provided data.
  if (/\bis not a function\b|\bnot callable\b/i.test(errorMessage)) {
    return "called_non_function";
  }
  if (
    /cannot read propert(?:y|ies) of (?:undefined|null)|(?:undefined|null) is not an object/i.test(
      errorMessage,
    )
  ) {
    return "null_or_undefined_access";
  }
  if (/\bis not iterable\b|non-iterable/i.test(errorMessage)) {
    return "not_iterable";
  }
  return "other_type_error";
}

function safeJavaScriptFrames(errorStack: unknown): string[] {
  if (typeof errorStack !== "string") return [];

  return errorStack
    .split(/\r?\n/)
    .map((line) => line.match(JS_BUNDLE_FRAME))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .slice(0, MAX_JS_FRAMES)
    .map((match) => `${match[1]}@${match[2]}:${match[3]}`);
}

/**
 * Formats a support diagnostic without copying the exception message or raw
 * stack. Only static function identifiers and numeric locations from bundled
 * JavaScript frames are retained; the message is used only to produce a fixed,
 * allow-listed failure category.
 */
export function createSafeErrorDiagnostic(
  errorName: unknown,
  componentStack?: string | null,
  errorMessage?: unknown,
  errorStack?: unknown,
): string {
  const errorType =
    typeof errorName === "string" && SAFE_ERROR_TYPES.has(errorName)
      ? errorName
      : "Error";

  const components = (componentStack ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(COMPONENT_FRAME)?.[1])
    .filter((component): component is string => Boolean(component))
    .slice(0, MAX_COMPONENTS);
  const componentPath =
    components.length > 0 ? components.join(" > ") : "unavailable";
  const failurePattern = classifyFailurePattern(errorType, errorMessage);
  const failureDetail = safeFailureDetail(errorType, errorMessage);
  const jsFrames = safeJavaScriptFrames(errorStack);

  const lines = [
    "LabTrax error diagnostic",
    `Error type: ${errorType}`,
    `Failure pattern: ${failurePattern}`,
    `Component path: ${componentPath}`,
  ];
  if (failureDetail) {
    lines.push(`Failure detail: ${failureDetail}`);
  }
  if (jsFrames.length > 0) {
    lines.push(`JavaScript frames: ${jsFrames.join(" > ")}`);
  }
  return lines.join("\n");
}
