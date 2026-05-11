#!/usr/bin/env bash
# setup-gcs-staging-bucket.sh
#
# Provisions the GCS staging bucket and service account needed for the CI
# installer-storage integration test, then prints the four GitHub Actions
# secrets that must be added to the repository.
#
# Pass --setup-rotation to also provision a second "rotation" service account
# that can create and delete keys on the CI runner SA.  This is required by
# the monthly key-rotation workflow (.github/workflows/rotate-ci-key.yml).
#
# Prerequisites
# -------------
#   gcloud  — authenticated via `gcloud auth login` or a key file
#             (the caller must have roles/storage.admin,
#              roles/iam.serviceAccountAdmin, and roles/iam.securityAdmin
#              on the target project; the last two are only needed when
#              --setup-rotation is used)
#   openssl — for generating CI_PLATFORM_ADMIN_SECRET (ships with macOS /
#             most Linux distros)
#   gh      — optional; if present the script offers to set the secrets
#             automatically via `gh secret set`
#
# Usage
# -----
#   bash .github/scripts/setup-gcs-staging-bucket.sh --project my-gcp-project
#   bash .github/scripts/setup-gcs-staging-bucket.sh --project my-gcp-project --setup-rotation
#
# Options
#   --project        GCP project ID (required)
#   --bucket         bucket name to create (default: <project>-labtrax-ci-staging)
#   --region         GCS bucket region    (default: us-central1)
#   --sa-name        CI runner service account name (default: labtrax-ci-runner)
#   --rotation-sa    rotation SA name (default: labtrax-ci-rotator)
#   --prefix         object prefix inside the bucket for CI objects
#                    (default: ci) — becomes PRIVATE_OBJECT_DIR=/<bucket>/<prefix>
#   --gh-repo        owner/repo for `gh secret set` (default: auto-detected from git)
#   --setup-rotation also create the rotation SA and print/set its secrets
#   --dry-run        print the gcloud commands that would be run without running them
#
# What the script creates (base run)
# -----------------------------------
#   1. A single-region GCS bucket with uniform bucket-level access.
#   2. A service account (labtrax-ci-runner) bound to
#      roles/storage.objectAdmin on that bucket only — not project-wide.
#   3. A service account JSON key written to /tmp/labtrax-ci-key.json.
#   4. A random 40-hex-char CI_PLATFORM_ADMIN_SECRET.
#
# What --setup-rotation adds
# --------------------------
#   5. A "rotation" service account (labtrax-ci-rotator) that is granted
#      roles/iam.serviceAccountKeyAdmin on the CI runner SA only.
#   6. A key for the rotation SA written to /tmp/labtrax-ci-rotator-key.json.
#
# After the script runs it prints all secret values and optionally sets them
# via `gh secret set`.  No production bucket or production secret is touched.

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

PROJECT=""
BUCKET=""
REGION="us-central1"
SA_NAME="labtrax-ci-runner"
ROTATION_SA_NAME="labtrax-ci-rotator"
PREFIX="ci"
GH_REPO=""
SETUP_ROTATION=false
DRY_RUN=false

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -60
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)        PROJECT="$2";          shift 2 ;;
    --bucket)         BUCKET="$2";           shift 2 ;;
    --region)         REGION="$2";           shift 2 ;;
    --sa-name)        SA_NAME="$2";          shift 2 ;;
    --rotation-sa)    ROTATION_SA_NAME="$2"; shift 2 ;;
    --prefix)         PREFIX="$2";           shift 2 ;;
    --gh-repo)        GH_REPO="$2";          shift 2 ;;
    --setup-rotation) SETUP_ROTATION=true;   shift   ;;
    --dry-run)        DRY_RUN=true;          shift   ;;
    -h|--help)        usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  echo "ERROR: --project is required." >&2
  echo "       Run: bash .github/scripts/setup-gcs-staging-bucket.sh --project YOUR_GCP_PROJECT_ID" >&2
  exit 1
fi

BUCKET="${BUCKET:-${PROJECT}-labtrax-ci-staging}"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
ROTATION_SA_EMAIL="${ROTATION_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
KEY_FILE="/tmp/labtrax-ci-key.json"
ROTATION_KEY_FILE="/tmp/labtrax-ci-rotator-key.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

run() {
  if $DRY_RUN; then
    echo "[DRY RUN] $*"
  else
    "$@"
  fi
}

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

if ! command -v openssl &>/dev/null; then
  echo "ERROR: openssl is not installed (needed to generate the admin secret)." >&2
  exit 1
fi

echo "  gcloud       : $(gcloud --version 2>/dev/null | head -1)"
echo "  project      : $PROJECT"
echo "  bucket       : $BUCKET"
echo "  region       : $REGION"
echo "  CI runner SA : $SA_EMAIL"
echo "  rotation SA  : $ROTATION_SA_EMAIL (created only with --setup-rotation)"
echo "  prefix       : $PREFIX"
if $DRY_RUN; then echo "  mode         : DRY RUN — no resources will be created"; fi

# ---------------------------------------------------------------------------
# 1. Create the GCS staging bucket
# ---------------------------------------------------------------------------

section "Step 1 — Create GCS bucket gs://$BUCKET"

if gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" &>/dev/null 2>&1; then
  echo "  Bucket gs://$BUCKET already exists — skipping creation."
else
  run gcloud storage buckets create "gs://$BUCKET" \
    --project="$PROJECT" \
    --location="$REGION" \
    --uniform-bucket-level-access
  echo "  Created gs://$BUCKET in $REGION."
fi

# ---------------------------------------------------------------------------
# 2. Create the CI runner service account
# ---------------------------------------------------------------------------

section "Step 2 — Create CI runner service account $SA_EMAIL"

if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" &>/dev/null 2>&1; then
  echo "  Service account $SA_EMAIL already exists — skipping creation."
else
  run gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" \
    --display-name="LabTrax CI runner (installer storage tests)"
  echo "  Created service account $SA_EMAIL."
fi

# ---------------------------------------------------------------------------
# 3. Grant objectAdmin on the bucket (bucket-level, NOT project-level)
# ---------------------------------------------------------------------------

section "Step 3 — Grant roles/storage.objectAdmin on gs://$BUCKET"

run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/storage.objectAdmin" \
  --project="$PROJECT"
echo "  Granted roles/storage.objectAdmin to $SA_EMAIL on gs://$BUCKET."

# ---------------------------------------------------------------------------
# 4. Create a service account key for the CI runner SA
# ---------------------------------------------------------------------------

section "Step 4 — Create CI runner service account key → $KEY_FILE"

if $DRY_RUN; then
  echo "[DRY RUN] gcloud iam service-accounts keys create $KEY_FILE --iam-account=$SA_EMAIL --project=$PROJECT"
  KEY_JSON='{"type":"service_account","dry_run":true}'
else
  run gcloud iam service-accounts keys create "$KEY_FILE" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT"
  KEY_JSON=$(cat "$KEY_FILE")
  echo "  Key written to $KEY_FILE."
  echo "  WARNING: This file contains a private key. Delete it after copying the secret value."
fi

# ---------------------------------------------------------------------------
# 5. Generate a random CI_PLATFORM_ADMIN_SECRET
# ---------------------------------------------------------------------------

section "Step 5 — Generate CI_PLATFORM_ADMIN_SECRET"

if $DRY_RUN; then
  ADMIN_SECRET="<will-be-generated-on-real-run>"
else
  ADMIN_SECRET=$(openssl rand -hex 20)
fi
echo "  Generated a 40-character hex secret."

# ---------------------------------------------------------------------------
# Compute secret values
# ---------------------------------------------------------------------------

PRIVATE_OBJECT_DIR="/${BUCKET}/${PREFIX}"
DEFAULT_OBJECT_STORAGE_BUCKET_ID="$BUCKET"

# ---------------------------------------------------------------------------
# --- Optional rotation SA setup (--setup-rotation) ---
# ---------------------------------------------------------------------------

ROTATION_KEY_JSON=""

if $SETUP_ROTATION; then

  section "Step 6 — Create rotation service account $ROTATION_SA_EMAIL"

  if gcloud iam service-accounts describe "$ROTATION_SA_EMAIL" --project="$PROJECT" &>/dev/null 2>&1; then
    echo "  Rotation SA $ROTATION_SA_EMAIL already exists — skipping creation."
  else
    run gcloud iam service-accounts create "$ROTATION_SA_NAME" \
      --project="$PROJECT" \
      --display-name="LabTrax CI key rotator (monthly key rotation only)"
    echo "  Created rotation service account $ROTATION_SA_EMAIL."
  fi

  # Grant roles/iam.serviceAccountKeyAdmin on the CI runner SA *only*.
  # This uses a resource-level IAM binding on the SA itself, not the project,
  # so the rotation SA cannot manage keys for any other SA in the project.
  section "Step 7 — Grant roles/iam.serviceAccountKeyAdmin on $SA_EMAIL (SA-level, not project-level)"

  run gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --member="serviceAccount:$ROTATION_SA_EMAIL" \
    --role="roles/iam.serviceAccountKeyAdmin" \
    --project="$PROJECT"
  echo "  Granted roles/iam.serviceAccountKeyAdmin to $ROTATION_SA_EMAIL on $SA_EMAIL."
  echo "  NOTE: This is SA-scoped — the rotation SA cannot manage keys for other SAs."

  section "Step 8 — Create rotation SA key → $ROTATION_KEY_FILE"

  if $DRY_RUN; then
    echo "[DRY RUN] gcloud iam service-accounts keys create $ROTATION_KEY_FILE --iam-account=$ROTATION_SA_EMAIL --project=$PROJECT"
    ROTATION_KEY_JSON='{"type":"service_account","dry_run":true}'
  else
    run gcloud iam service-accounts keys create "$ROTATION_KEY_FILE" \
      --iam-account="$ROTATION_SA_EMAIL" \
      --project="$PROJECT"
    ROTATION_KEY_JSON=$(cat "$ROTATION_KEY_FILE")
    echo "  Key written to $ROTATION_KEY_FILE."
    echo "  WARNING: This file contains a private key. Delete it after copying the secret value."
  fi

fi

# ---------------------------------------------------------------------------
# Summary — base secrets
# ---------------------------------------------------------------------------

section "GitHub Actions secrets to configure"

cat <<EOF

Add these four secrets to your repository at:
  https://github.com/<owner>/<repo>/settings/secrets/actions

  Secret name                          Value
  ───────────────────────────────────  ──────────────────────────────────────
  CI_PRIVATE_OBJECT_DIR                ${PRIVATE_OBJECT_DIR}
  CI_DEFAULT_OBJECT_STORAGE_BUCKET_ID  ${DEFAULT_OBJECT_STORAGE_BUCKET_ID}
  CI_PLATFORM_ADMIN_SECRET             ${ADMIN_SECRET}
  CI_GOOGLE_CREDENTIALS_JSON           (contents of ${KEY_FILE} — see below)

EOF

if ! $DRY_RUN; then
  echo "CI_GOOGLE_CREDENTIALS_JSON value (copy everything between the dashes):"
  echo "---"
  echo "$KEY_JSON"
  echo "---"
fi

# ---------------------------------------------------------------------------
# Summary — rotation secrets (if provisioned)
# ---------------------------------------------------------------------------

if $SETUP_ROTATION && [[ -n "$ROTATION_KEY_JSON" ]]; then
  cat <<EOF

  Additionally, for the monthly key-rotation workflow
  (.github/workflows/rotate-ci-key.yml), add these two secrets:

  Secret name                    Value
  ─────────────────────────────  ──────────────────────────────────────────
  CI_ROTATION_CREDENTIALS_JSON   (contents of ${ROTATION_KEY_FILE} — see below)
  ROTATION_GITHUB_PAT            A fine-grained PAT with "Secrets: Read and
                                 write" permission on this repository.
                                 Create at:
                                 https://github.com/settings/personal-access-tokens

  The rotation workflow runs automatically on the 1st of every month and can
  also be triggered manually from Actions → "Rotate CI GCS Key".

EOF

  if ! $DRY_RUN; then
    echo "CI_ROTATION_CREDENTIALS_JSON value (copy everything between the dashes):"
    echo "---"
    echo "$ROTATION_KEY_JSON"
    echo "---"
  fi
fi

# ---------------------------------------------------------------------------
# Optional: set secrets automatically via gh CLI
# ---------------------------------------------------------------------------

if command -v gh &>/dev/null && ! $DRY_RUN; then
  echo ""
  echo "The GitHub CLI (gh) is available."
  read -r -p "Set base secrets automatically via 'gh secret set'? [y/N] " REPLY
  if [[ "${REPLY}" =~ ^[Yy]$ ]]; then
    if [[ -z "$GH_REPO" ]]; then
      GH_REPO=$(git remote get-url origin 2>/dev/null \
        | sed 's|https://github.com/||;s|git@github.com:||;s|\.git$||' || true)
    fi
    if [[ -z "$GH_REPO" ]]; then
      echo "ERROR: Could not detect GitHub repo from git remote. Pass --gh-repo owner/repo." >&2
    else
      echo ""
      echo "Setting base secrets for $GH_REPO …"
      echo "$PRIVATE_OBJECT_DIR"              | gh secret set CI_PRIVATE_OBJECT_DIR              --repo "$GH_REPO"
      echo "$DEFAULT_OBJECT_STORAGE_BUCKET_ID" | gh secret set CI_DEFAULT_OBJECT_STORAGE_BUCKET_ID --repo "$GH_REPO"
      echo "$ADMIN_SECRET"                    | gh secret set CI_PLATFORM_ADMIN_SECRET            --repo "$GH_REPO"
      echo "$KEY_JSON"                        | gh secret set CI_GOOGLE_CREDENTIALS_JSON           --repo "$GH_REPO"
      echo ""
      echo "Base secrets set."

      if $SETUP_ROTATION && [[ -n "$ROTATION_KEY_JSON" ]]; then
        read -r -p "Also set CI_ROTATION_CREDENTIALS_JSON? [y/N] " ROTATION_REPLY
        if [[ "${ROTATION_REPLY}" =~ ^[Yy]$ ]]; then
          echo "$ROTATION_KEY_JSON" | gh secret set CI_ROTATION_CREDENTIALS_JSON --repo "$GH_REPO"
          echo ""
          echo "CI_ROTATION_CREDENTIALS_JSON set."
          echo "Remember to also set ROTATION_GITHUB_PAT manually — it requires a personal access token you create at https://github.com/settings/personal-access-tokens"
        fi
      fi

      echo ""
      echo "Trigger a CI run to verify:"
      echo "  gh workflow run ci.yml --repo $GH_REPO"
    fi
  fi
else
  if ! $DRY_RUN; then
    echo "(Install 'gh' and run 'gh auth login' to set secrets automatically next time.)"
  fi
fi

# ---------------------------------------------------------------------------
# Cleanup reminder
# ---------------------------------------------------------------------------

if ! $DRY_RUN; then
  echo ""
  echo "IMPORTANT: Delete the local key file(s) once you have set the secrets:"
  echo "  rm -f $KEY_FILE"
  if $SETUP_ROTATION; then
    echo "  rm -f $ROTATION_KEY_FILE"
  fi
fi

echo ""
echo "Done."
