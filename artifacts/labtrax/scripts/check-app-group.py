#!/usr/bin/env python3
"""Verify (and optionally fix) the App Group setup for both LabTrax bundle IDs
via the App Store Connect API."""
import os, sys, time, json
import jwt, requests

KEY_PATH = os.environ.get("EXPO_ASC_API_KEY_PATH", "/tmp/AuthKey_RV23AJ8V62.p8")
KEY_ID = os.environ.get("EXPO_ASC_KEY_ID", "RV23AJ8V62")
ISSUER_ID = os.environ.get("EXPO_ASC_ISSUER_ID", "1d2faabc-3d66-4e64-b514-c234043e143a")
BUNDLE_IDS = ["app.replit.labtrax", "app.replit.labtrax.share-extension"]
APP_GROUP_IDENT = "group.app.replit.labtrax.sdr"

with open(KEY_PATH, "rb") as f:
    private_key = f.read()
token = jwt.encode(
    {"iss": ISSUER_ID, "iat": int(time.time()), "exp": int(time.time()) + 600, "aud": "appstoreconnect-v1"},
    private_key, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})
H = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
BASE = "https://api.appstoreconnect.apple.com/v1"

# 1) Look up the App Group resource itself
print(f"=== Looking up App Group '{APP_GROUP_IDENT}' ===", flush=True)
r = requests.get(f"{BASE}/appGroups?filter[identifier]={APP_GROUP_IDENT}", headers=H)
print(f"  status={r.status_code}", flush=True)
ag_data = r.json().get("data", [])
if not ag_data:
    print(f"  NOT FOUND. Listing all App Groups visible to this API key:", flush=True)
    r2 = requests.get(f"{BASE}/appGroups", headers=H)
    for ag in r2.json().get("data", []):
        print(f"    - {ag['attributes']['identifier']} (name={ag['attributes']['name']}, id={ag['id']})", flush=True)
    sys.exit(1)
APP_GROUP_ID = ag_data[0]["id"]
print(f"  ✓ exists, id={APP_GROUP_ID} name={ag_data[0]['attributes']['name']}", flush=True)

# 2) For each bundle id, list capabilities and app-group assignment
for bid in BUNDLE_IDS:
    print(f"\n=== Bundle: {bid} ===", flush=True)
    r = requests.get(f"{BASE}/bundleIds?filter[identifier]={bid}&include=bundleIdCapabilities,appGroups", headers=H)
    data = r.json()
    bundles = data.get("data", [])
    if not bundles:
        print(f"  Bundle ID resource not found.", flush=True)
        continue
    b = bundles[0]
    BUNDLE_RESOURCE_ID = b["id"]
    included = {(it["type"], it["id"]): it for it in data.get("included", [])}
    print(f"  resource id={BUNDLE_RESOURCE_ID}", flush=True)

    caps_rel = b["relationships"].get("bundleIdCapabilities", {}).get("data", [])
    cap_types = []
    has_app_groups_cap = False
    for cap_ref in caps_rel:
        cap = included.get(("bundleIdCapabilities", cap_ref["id"]))
        if cap:
            cap_type = cap["attributes"].get("capabilityType")
            cap_types.append(cap_type)
            if cap_type == "APP_GROUPS":
                has_app_groups_cap = True
    print(f"  capabilities enabled: {sorted(cap_types)}", flush=True)
    print(f"  APP_GROUPS capability enabled? {has_app_groups_cap}", flush=True)

    # App group assignments
    ag_rel = b["relationships"].get("appGroups", {}).get("data", []) if "appGroups" in b["relationships"] else []
    assigned_groups = []
    for ag_ref in ag_rel:
        ag = included.get(("appGroups", ag_ref["id"]))
        if ag:
            assigned_groups.append(ag["attributes"]["identifier"])
    print(f"  app groups assigned: {assigned_groups}", flush=True)
    has_correct_group = APP_GROUP_IDENT in assigned_groups
    print(f"  '{APP_GROUP_IDENT}' assigned? {has_correct_group}", flush=True)

    if not has_app_groups_cap:
        print(f"  → Enabling APP_GROUPS capability via API...", flush=True)
        body = {"data": {"type": "bundleIdCapabilities", "attributes": {"capabilityType": "APP_GROUPS"},
                         "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": BUNDLE_RESOURCE_ID}}}}}
        cr = requests.post(f"{BASE}/bundleIdCapabilities", headers=H, json=body)
        print(f"    POST /bundleIdCapabilities → {cr.status_code} {cr.text[:300]}", flush=True)

    if not has_correct_group:
        print(f"  → Assigning App Group via PATCH bundleIds/{BUNDLE_RESOURCE_ID}/relationships/appGroups...", flush=True)
        body = {"data": [{"type": "appGroups", "id": APP_GROUP_ID}]}
        pr = requests.patch(f"{BASE}/bundleIds/{BUNDLE_RESOURCE_ID}/relationships/appGroups", headers=H, json=body)
        print(f"    PATCH → {pr.status_code} {pr.text[:300]}", flush=True)
