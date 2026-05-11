#!/usr/bin/env bash
# cleanup-ci-staging-bucket.sh
#
# Deletes all objects under the CI prefix in the GCS staging bucket so that
# leftover dummy files from interrupted test runs (OOM kills, network outages,
# CI timeouts) do not accumulate.
#
# The installer-storage E2E test (installer-storage-e2e.test.ts) removes its
# dummy objects in afterAll, but if the runner is killed mid-test those objects
# are stranded.  Run this script to restore a clean slate.
#
# The script is safe to run repeatedly: when the prefix is already empty it
# prints "Nothing to clean up" and exits 0.
#
# Prerequisites
# -------------
#   gcloud  — authenticated via `gcloud auth login` or a key file
#             (the caller must have roles/storage.objectAdmin on the bucket)
#
# Usage
# -----
#   bash .github/scripts/cleanup-ci-staging-bucket.sh --project my-gcp-project
#
# Options
#   --project  GCP project ID (required)
#   --bucket   bucket name (default: <project>-labtrax-ci-staging)
#              must match the value used by setup-gcs-staging-bucket.sh
#   --prefix   object prefix to wipe (default: ci)
#              must match the --prefix used when the bucket was provisioned
#   --dry-run  list the objects that would be deleted without deleting them
#
# See also
# --------
#   .github/scripts/setup-gcs-staging-bucket.sh — provisions the staging bucket

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

PROJECT=""
BUCKET=""
PREFIX="ci"
DRY_RUN=false

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -60
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --bucket)  BUCKET="$2";  shift 2 ;;
    --prefix)  PREFIX="$2";  shift 2 ;;
    --dry-run) DRY_RUN=true; shift   ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  echo "ERROR: --project is required." >&2
  echo "       Run: bash .github/scripts/cleanup-ci-staging-bucket.sh --project YOUR_GCP_PROJECT_ID" >&2
  exit 1
fi

if [[ -z "$PREFIX" ]]; then
  echo "ERROR: --prefix must not be empty (would delete the entire bucket)." >&2
  exit 1
fi

BUCKET="${BUCKET:-${PROJECT}-labtrax-ci-staging}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $*"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

section "Preflight checks"

if ! command -v gcloud &>/dev/null; then
  echo "ERROR: gcloud is not installed. Install the Google Cloud SDK:" >&2
  echo "       https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi

echo "  gcloud : $(gcloud --version 2>/dev/null | head -1)"
echo "  project: $PROJECT"
echo "  bucket : gs://$BUCKET"
echo "  prefix : $PREFIX"
if $DRY_RUN; then echo "  mode   : DRY RUN — no objects will be deleted"; fi

# ---------------------------------------------------------------------------
# Verify bucket exists
# ---------------------------------------------------------------------------

section "Checking bucket gs://$BUCKET"

if ! gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" &>/dev/null 2>&1; then
  echo "  Bucket gs://$BUCKET does not exist in project $PROJECT."
  echo "  Nothing to clean up."
  echo ""
  echo "Done."
  exit 0
fi

echo "  Bucket exists."

# ---------------------------------------------------------------------------
# List objects under the CI prefix
# ---------------------------------------------------------------------------

section "Listing objects under gs://$BUCKET/$PREFIX/"

# Collect the object URIs into an array.
mapfile -t OBJECTS < <(
  gcloud storage ls --project="$PROJECT" "gs://$BUCKET/$PREFIX/**" 2>/dev/null || true
)

if [[ ${#OBJECTS[@]} -eq 0 ]]; then
  echo "  Nothing to clean up — prefix gs://$BUCKET/$PREFIX/ is already empty."
  echo ""
  echo "Done."
  exit 0
fi

echo "  Found ${#OBJECTS[@]} object(s) under gs://$BUCKET/$PREFIX/:"
for obj in "${OBJECTS[@]}"; do
  echo "    $obj"
done

# ---------------------------------------------------------------------------
# Delete the objects
# ---------------------------------------------------------------------------

if $DRY_RUN; then
  section "DRY RUN — objects that would be deleted"
  for obj in "${OBJECTS[@]}"; do
    echo "  [DRY RUN] would delete: $obj"
  done
  echo ""
  echo "  Re-run without --dry-run to perform the actual deletion."
else
  section "Deleting ${#OBJECTS[@]} object(s)"

  for obj in "${OBJECTS[@]}"; do
    gcloud storage rm --project="$PROJECT" "$obj"
    echo "  Deleted: $obj"
  done

  echo ""
  echo "  Verifying prefix is now empty…"
  mapfile -t REMAINING < <(
    gcloud storage ls --project="$PROJECT" "gs://$BUCKET/$PREFIX/**" 2>/dev/null || true
  )
  if [[ ${#REMAINING[@]} -eq 0 ]]; then
    echo "  Prefix gs://$BUCKET/$PREFIX/ is empty. Cleanup complete."
  else
    echo "WARNING: ${#REMAINING[@]} object(s) still remain under gs://$BUCKET/$PREFIX/." >&2
    echo "         Re-run the script to retry, or inspect the bucket manually." >&2
    exit 1
  fi
fi

echo ""
echo "Done."
