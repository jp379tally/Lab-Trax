#!/usr/bin/env python3
"""Delete Expo-cached provisioning profiles via the Expo GraphQL API.
Apple-side delete is not enough: EAS caches profile blobs on its own servers
and reuses them even after Apple revokes them, producing the dreaded
"provisioning profile … doesn't support the group.* App Group" loop after a
capability is added to the App ID. This forces eas-cli to re-issue from Apple."""
import os, sys, json
import requests

TOKEN = os.environ["EXPO_TOKEN"]
ACCOUNT = "jp379"
PROJECT_FULL_NAME = "@jp379/labtrax"
BUNDLE_IDS = ["app.replit.labtrax", "app.replit.labtrax.share-extension"]
URL = "https://api.expo.dev/graphql"
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def gql(query, variables):
    r = requests.post(URL, headers=H, json={"query": query, "variables": variables})
    r.raise_for_status()
    payload = r.json()
    if payload.get("errors"):
        raise RuntimeError(json.dumps(payload["errors"], indent=2))
    return payload["data"]

LIST_Q = """
query($accountName: String!, $bundleIdentifier: String!) {
  account {
    byName(accountName: $accountName) {
      appleAppIdentifiers(bundleIdentifier: $bundleIdentifier) {
        id
        bundleIdentifier
      }
    }
  }
}
"""

CREDS_Q = """
query($projectFullName: String!, $appleAppIdentifierId: String!) {
  app {
    byFullName(fullName: $projectFullName) {
      iosAppCredentials(filter: { appleAppIdentifierId: $appleAppIdentifierId }) {
        id
        iosAppBuildCredentialsList {
          id
          iosDistributionType
          provisioningProfile {
            id
            developerPortalIdentifier
          }
        }
      }
    }
  }
}
"""

DEL_M = """
mutation($ids: [ID!]!) {
  appleProvisioningProfile {
    deleteAppleProvisioningProfiles(ids: $ids) {
      id
    }
  }
}
"""

all_profile_ids = []
for bundle in BUNDLE_IDS:
    print(f"\nBundle: {bundle}", flush=True)
    d = gql(LIST_Q, {"accountName": ACCOUNT, "bundleIdentifier": bundle})
    idents = d["account"]["byName"]["appleAppIdentifiers"]
    if not idents:
        print(f"  no AppleAppIdentifier found", flush=True)
        continue
    for ident in idents:
        aid = ident["id"]
        creds = gql(CREDS_Q, {"projectFullName": PROJECT_FULL_NAME, "appleAppIdentifierId": aid})
        for c in creds["app"]["byFullName"]["iosAppCredentials"]:
            for b in c["iosAppBuildCredentialsList"]:
                pp = b.get("provisioningProfile")
                if pp:
                    print(f"  expo-id={pp['id']} apple-id={pp.get('developerPortalIdentifier')} dist={b['iosDistributionType']}", flush=True)
                    all_profile_ids.append(pp["id"])

print(f"\nDeleting {len(all_profile_ids)} cached Expo profile(s)...", flush=True)
if all_profile_ids:
    result = gql(DEL_M, {"ids": all_profile_ids})
    print(f"  done: {json.dumps(result, indent=2)}", flush=True)
else:
    print("  nothing to delete", flush=True)
