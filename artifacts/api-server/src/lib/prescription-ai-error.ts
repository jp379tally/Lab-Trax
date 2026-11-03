type FailureKind = "authentication" | "quota" | "rate_limit" | "model" | "request" | "unavailable" | "timeout" | "unknown";

/** Never return/log an upstream message, body, headers, or arbitrary error code:
 * providers can echo prescription content and credentials in those fields. */
export function prescriptionAiFailure(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const nested = value.error && typeof value.error === "object"
    ? value.error as Record<string, unknown> : {};
  const code = value.code ?? nested.code;
  const upstreamStatus = typeof value.status === "number" && Number.isInteger(value.status)
    && value.status >= 400 && value.status <= 599 ? value.status : undefined;
  let kind: FailureKind = "unknown";
  let status = 500;
  let publicCode = "AI_ANALYSIS_FAILED";
  let message = "AI analysis failed. Please try again.";
  let tryNextModel = true;

  if (upstreamStatus === 401 || upstreamStatus === 403 || code === "invalid_api_key") {
    kind = "authentication";
    status = 503;
    publicCode = "AI_CONFIGURATION_ERROR";
    message = "The AI service could not authenticate. Ask your administrator to check the AI integration configuration. No case was created by this analysis.";
    // A 403 can be model-specific; retain the existing fallback in that case.
    tryNextModel = upstreamStatus === 403 && code !== "invalid_api_key";
  } else if (code === "insufficient_quota") {
    kind = "quota";
    status = 503;
    publicCode = "AI_QUOTA_UNAVAILABLE";
    message = "The AI service has no available usage quota. Ask your administrator to check the AI integration account. No case was created by this analysis.";
    tryNextModel = false;
  } else if (upstreamStatus === 429) {
    kind = "rate_limit";
    status = 503;
    publicCode = "AI_SERVICE_BUSY";
    message = "The AI service is busy. Please wait briefly and try again, or enter the details manually. No case was created by this analysis.";
  } else if (upstreamStatus === 404 || code === "model_not_found") {
    kind = "model";
    status = 503;
    publicCode = "AI_MODEL_UNAVAILABLE";
    message = "The configured AI models are unavailable. Ask your administrator to check model access for the AI integration. No case was created by this analysis.";
  } else if (value.name === "APIConnectionTimeoutError" || value.name === "TimeoutError" || value.name === "AbortError") {
    kind = "timeout";
    status = 504;
    publicCode = "AI_ANALYSIS_TIMEOUT";
    message = "AI analysis timed out. Try again or enter the details manually. No case was created by this analysis.";
  } else if ((upstreamStatus !== undefined && upstreamStatus >= 500) || value.name === "APIConnectionError") {
    kind = "unavailable";
    status = 503;
    publicCode = "AI_SERVICE_UNAVAILABLE";
    message = "The AI service is temporarily unavailable. Try again shortly or enter the details manually. No case was created by this analysis.";
  } else if (upstreamStatus === 400 || upstreamStatus === 422) {
    kind = "request";
    status = 502;
    publicCode = "AI_REQUEST_REJECTED";
    message = "The AI service rejected the analysis request. Ask your administrator to check the Reader integration. No case was created by this analysis.";
  }

  return {
    status,
    body: { success: false as const, code: publicCode, error: message },
    diagnostics: { failureKind: kind, ...(upstreamStatus === undefined ? {} : { upstreamStatus }) },
    tryNextModel,
  };
}
