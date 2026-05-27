#!/usr/bin/env python3
"""Create the App Group + enable APP_GROUPS capability + assign to both bundles
via the App Store Connect API. Requires the ASC API key to have Admin role."""
import os, sys, time, json
import jwt, requests

KEY_PATH = "/tmp/AuthKey_RV23AJ8V62.p8"
KEY_ID = "RV23AJ8V62"
ISSUER_ID = "1d2faabc-3d66-4e64-b514-c234043e143a"
APP_GROUP_IDENT = "group.app.replit.labtrax.sdr"
APP_GROUP_NAME = "LabTrax Share Group"
BUNDLE_IDS = ["app.replit.labtrax", "app.replit.labtrax.share-extension"]

with open(KEY_PATH, "rb") as f:
    private_key = f.read()
token = jwt.encode(
    {"iss": ISSUER_ID, "iat": int(time.time()), "exp": int(time.time()) + 600, "aud": "appstoreconnect-v1"},
    private_key, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})
H = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
BASE = "https://api.appstoreconnect.apple.com/v1"

# Step 1: create the App Group (if missing)
print(f"=== Step 1: create App Group '{APP_GROUP_IDENT}' ===", flush=True)
r = requests.get(f"{BASE}/appGroups?filter[identifier]={APP_GROUP_IDENT}", headers=H)
existing = r.json().get("data", [])
if existing:
    APP_GROUP_ID = existing[0]["id"]
    print(f"  already exists, id={APP_GROUP_ID}", flush=True)
else:
    body = {"data": {"type": "appGroups", "attributes": {"identifier": APP_GROUP_IDENT, "name": APP_GROUP_NAME}}}
    cr = requests.post(f"{BASE}/appGroups", headers=H, json=body)
    print(f"  POST /appGroups → {cr.status_code}", flush=True)
    if cr.status_code not in (200, 201):
        print(f"  RESPONSE: {cr.text}", flush=True)
        sys.exit(1)
    APP_GROUP_ID = cr.json()["data"]["id"]
    print(f"  ✓ created, id={APP_GROUP_ID}", flush=True)

# Step 2: enable APP_GROUPS capability + assign group on each bundle
for bid in BUNDLE_IDS:
    print(f"\n=== Step 2: bundle {bid} ===", flush=True)
    r = requests.get(f"{BASE}/bundleIds?filter[identifier]={bid}&include=bundleIdCapabilities,appGroups", headers=H)
    data = r.json()
    bundles = data.get("data", [])
    if not bundles:
        print(f"  bundle resource not found", flush=True)
        continue
    b = bundles[0]
    BUNDLE_RESOURCE_ID = b["id"]
    included = {(it["type"], it["id"]): it for it in data.get("included", [])}
    cap_types = []
    has_app_groups_cap = False
    for cap_ref in b["relationships"].get("bundleIdCapabilities", {}).get("data", []):
        cap = included.get(("bundleIdCapabilities", cap_ref["id"]))
        if cap:
            ct = cap["attributes"].get("capabilityType")
            cap_types.append(ct)
            if ct == "APP_GROUPS":
                has_app_groups_cap = True
    print(f"  current capabilities: {sorted(cap_types)}", flush=True)

    if not has_app_groups_cap:
        print(f"  → enabling APP_GROUPS capability...", flush=True)
        body = {"data": {"type": "bundleIdCapabilities", "attributes": {"capabilityType": "APP_GROUPS"},
                         "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": BUNDLE_RESOURCE_ID}}}}}
        cr = requests.post(f"{BASE}/bundleIdCapabilities", headers=H, json=body)
        print(f"    → {cr.status_code} {cr.text[:300]}", flush=True)

    print(f"  → assigning App Group to bundle...", flush=True)
    body = {"data": [{"type": "appGroups", "id": APP_GROUP_ID}]}
    pr = requests.patch(f"{BASE}/bundleIds/{BUNDLE_RESOURCE_ID}/relationships/appGroups", headers=H, json=body)
    print(f"    → {pr.status_code} {pr.text[:300] or '(empty body)'}", flush=True)

print("\n=== Done. Verifying ===", flush=True)
for bid in BUNDLE_IDS:
    r = requests.get(f"{BASE}/bundleIds?filter[identifier]={bid}&include=appGroups", headers=H)
    data = r.json()
    b = data["data"][0]
    included = {(it["type"], it["id"]): it for it in data.get("included", [])}
    assigned = [included[("appGroups", ag["id"])]["attributes"]["identifier"]
                for ag in b["relationships"].get("appGroups", {}).get("data", [])]
    print(f"  {bid} → assigned groups: {assigned}", flush=True)
