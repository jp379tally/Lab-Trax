#!/usr/bin/env python3
"""Delete cached iOS provisioning profiles via ASC API so eas-cli regenerates fresh ones."""
import os, sys, time, json
import jwt, requests

KEY_PATH = os.environ.get("EXPO_ASC_API_KEY_PATH", "/tmp/AuthKey_RV23AJ8V62.p8")
KEY_ID = os.environ.get("EXPO_ASC_KEY_ID", "RV23AJ8V62")
ISSUER_ID = os.environ.get("EXPO_ASC_ISSUER_ID", "1d2faabc-3d66-4e64-b514-c234043e143a")
BUNDLE_IDS = {"app.replit.labtrax", "app.replit.labtrax.share-extension"}

with open(KEY_PATH, "rb") as f:
    private_key = f.read()

token = jwt.encode(
    {"iss": ISSUER_ID, "iat": int(time.time()), "exp": int(time.time()) + 600, "aud": "appstoreconnect-v1"},
    private_key, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"},
)
H = {"Authorization": f"Bearer {token}"}
BASE = "https://api.appstoreconnect.apple.com/v1"

# List all profiles, include bundleId relationship
url = f"{BASE}/profiles?limit=200&include=bundleId"
r = requests.get(url, headers=H)
r.raise_for_status()
data = r.json()
profiles = data["data"]
included = {(it["type"], it["id"]): it for it in data.get("included", [])}

deleted = 0
for p in profiles:
    name = p["attributes"]["name"]
    state = p["attributes"]["profileState"]
    bid_rel = p["relationships"].get("bundleId", {}).get("data")
    if not bid_rel:
        continue
    bid_obj = included.get(("bundleIds", bid_rel["id"]))
    if not bid_obj:
        continue
    identifier = bid_obj["attributes"]["identifier"]
    if identifier in BUNDLE_IDS:
        print(f"  found profile id={p['id']} name={name!r} state={state} bundle={identifier}", flush=True)
        d = requests.delete(f"{BASE}/profiles/{p['id']}", headers=H)
        if d.status_code in (204, 200):
            print(f"    DELETED", flush=True)
            deleted += 1
        else:
            print(f"    DELETE failed status={d.status_code} body={d.text[:300]}", flush=True)

print(f"\nDeleted {deleted} provisioning profile(s). eas-cli will regenerate fresh ones on next build.", flush=True)
