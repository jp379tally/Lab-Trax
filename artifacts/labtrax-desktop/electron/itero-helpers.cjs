"use strict";

/**
 * Pure helpers extracted from itero-poller.cjs so they can be unit-tested
 * in plain Node (no Electron runtime dependency).
 */

const DEFAULT_POLL_INTERVAL_MIN = 5;
const MIN_POLL_INTERVAL_MIN = 5;
const MAX_POLL_INTERVAL_MIN = 240;

function clampInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_POLL_INTERVAL_MIN;
  return Math.min(MAX_POLL_INTERVAL_MIN, Math.max(MIN_POLL_INTERVAL_MIN, Math.round(n)));
}

function looksLikeLoginPage(text) {
  if (!text) return false;
  return /login|sign[\s-]?in|password/i.test(text.slice(0, 4000)) &&
    /<html/i.test(text.slice(0, 500));
}

const LAB_REVIEW_STATUS_TOKENS = new Set(["labreview"]);

function normalizeStatusToken(value) {
  if (value == null) return "";
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isLabReviewOrder(raw) {
  if (!raw || typeof raw !== "object") return false;
  const candidates = [
    raw.status,
    raw.orderStatus,
    raw.caseStatus,
    raw.statusName,
    raw.workflowStatus,
    raw.state,
    raw.stage,
    raw.status?.name,
    raw.status?.code,
  ];
  for (const c of candidates) {
    const tok = normalizeStatusToken(c);
    if (tok && LAB_REVIEW_STATUS_TOKENS.has(tok)) return true;
  }
  return false;
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MIN,
  MIN_POLL_INTERVAL_MIN,
  MAX_POLL_INTERVAL_MIN,
  LAB_REVIEW_STATUS_TOKENS,
  clampInterval,
  looksLikeLoginPage,
  normalizeStatusToken,
  isLabReviewOrder,
};
