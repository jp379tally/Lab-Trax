# Microsoft Store submission checklist

This checklist prepares LabTrax Desktop for a Partner Center submission. It
does not publish the app or make decisions on the owner's behalf.

## Distribution routes

Microsoft currently supports both an MSIX package for a Win32/Electron app and
a listing that links to an existing offline `.exe` or `.msi` installer. LabTrax
uses MSIX as the additional Store channel. The separate `LabTrax-Setup.exe`
continues to be built, published at `/downloads/LabTrax-Setup.exe`, and used by
the existing generic `electron-updater` feed.

The Store artifact is `LabTrax-Store.msix`, built from the Windows
`win-unpacked` output. It is x64-only and has a four-part package version:
`major.minor.patch.buildNumber`. The Partner Center identity values are not
invented in source. The build requires these GitHub Actions repository
**variables** when the Store package option is enabled:

| Variable | Value to copy from Partner Center |
|---|---|
| `STORE_PACKAGE_IDENTITY_NAME` | The app's exact package Identity Name |
| `STORE_PACKAGE_PUBLISHER` | The exact Publisher distinguished name, including `CN=` |
| `STORE_PACKAGE_PUBLISHER_DISPLAY_NAME` | The account's exact publisher display name |

The build uses the Microsoft `winapp` CLI to create the MSIX with `--no-sign`.
Microsoft documents that option for Store submissions: a CA-trusted signature
is not required and the Store re-signs accepted packages after certification.
The CI validator therefore requires that the submission package is unsigned,
then checks identity, version, x64 architecture, package contents, image sizes,
and the declared `internetClient` and `runFullTrust` capabilities. Do not use
this unsigned Store package for direct sideloading.

The CLI is pinned to `@microsoft/winappcli` 0.7.1; Microsoft labels it as
Public Preview, so confirm the current CLI and Partner Center requirements
before relying on it for a submission.

The Store app is identified at runtime by Electron's `process.windowsStore`
flag. It does not use the NSIS auto-update feed; Microsoft Store manages Store
install updates. The direct EXE path remains independent and continues to use
the existing update feed. The Store package is opt-in in the GitHub Actions
**Release** and **Build Windows Installer (Test)** workflows, so existing
releases remain unchanged until Partner Center values are configured.

## Owner actions in Partner Center

- [ ] Create and verify an individual or company Microsoft Partner Center
  developer account. Complete any business, identity, tax, and payout
  verification Partner Center requests.
- [ ] Reserve the product name and create a new MSIX app submission.
- [ ] Copy the three exact identity/publisher values shown in the app's
  **Product management** / identity details into the GitHub Actions variables
  listed above. These are public package metadata, not credentials.
- [ ] Decide the app's public listing name, concise and full descriptions,
  feature list, supported language(s), category/subcategory, search terms,
  target markets, public/private audience, discoverability, pricing, and
  release schedule. These are owner and business decisions.
- [ ] Provide a support URL and support contact details that the owner is
  prepared to maintain.
- [ ] Decide whether the app accesses, collects, or transmits personal
  information. The LabTrax product connects to authenticated lab services; the
  owner must confirm the privacy statement and provide a public privacy-policy
  URL. Microsoft may require the policy based on the app's capabilities and
  data flows.
- [ ] Complete every question in Partner Center's age-rating questionnaire
  accurately. The rating is based on app content and declarations, not merely
  the intended business audience.
- [ ] Review every product declaration that Partner Center presents, including
  third-party commerce, accessibility, device/install options, encryption,
  advertising, and any declarations specific to the chosen category. Only make
  declarations that the owner can substantiate.

## Listing assets and content

- [ ] Enter at least one language's Store listing description and upload at
  least one genuine screenshot of the released desktop app. Microsoft
  recommends four or more screenshots.
- [ ] Prepare a Store logo and any optional promotional or feature graphics,
  additional screenshots, and trailer. Confirm the required dimensions and
  formats shown by the current Partner Center listing form before upload.
- [ ] Ensure the screenshots and copy accurately describe LabTrax and do not
  expose real customer, patient, or lab information.
- [ ] Review localization, accessibility statements, trademarks, and any
  claims about supported Windows versions before saving the listing.

The package's four manifest images are generated from the current app icon.
Those package assets do not replace the owner-approved screenshots and
promotional assets required for the public Store listing.

## Build, test, submit, and certification

1. Configure the three GitHub Actions variables above from Partner Center.
2. Run **Release** on an existing version tag with **include_store_package**
   enabled. The Windows job builds the standalone NSIS installer as usual,
   then builds and validates `LabTrax-Store.msix` before publishing release
   artifacts. It uploads the MSIX as a separate workflow artifact and attaches
   it separately to the draft GitHub release; it does not replace
   `LabTrax-Setup.exe` or the live download-page URL.
3. In a clean Windows 10/11 test machine with developer mode enabled, install
   and launch the MSIX using a development-signed test copy or a package
   returned by Partner Center. Check sign-in, networking, local file access,
   and that the Store app does not offer the direct-installer update action.
   Remove the test package before testing the direct installer so the two
   channels cannot be confused.
4. Separately run the existing Windows installed-installer smoke workflow and
   follow the **Pushing an auto-update to NSIS-installed users** procedure in
   `auto-update-runbook.md`. Confirm `latest.yml` names
   `LabTrax-Setup.exe`, install the old direct build, and complete an N → N+1
   update using the existing feed.
5. Upload the Store MSIX in Partner Center. Run Microsoft's Windows App
   Certification Kit (WACK) on Windows and resolve its findings before
   submission.
6. Complete and submit the listing, age rating, declarations, markets, and
   package for certification. Monitor Partner Center and its email/action
   center for certification results. If rejected, resolve each cited issue,
   rebuild with a higher package version, and submit again.
7. Owner approval is required before setting availability or publishing.
   Microsoft Store certification, account verification, final listing
   decisions, and responding to certification feedback cannot be completed by
   this repository's CI.

## Microsoft references

- [Win32/Electron Store distribution routes](https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-distribute-your-win32-app-through-microsoft-store)
- [Microsoft's Electron MSIX packaging guide](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/electron-packaging)
- [Microsoft's `winapp` CLI packaging guide](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/packaging-cli)
- [`winapp pack` signing options](https://github.com/microsoft/winappCli/blob/main/docs/usage.md)
- [MSIX package requirements and Store signing](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Create an MSIX app submission](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission)
- [Store listing details](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info)
- [Privacy policy and support info](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info)
- [Product declarations](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/product-declarations)
- [Age ratings](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/age-ratings)
- [Windows App Certification Kit](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-app-certification-kit)
