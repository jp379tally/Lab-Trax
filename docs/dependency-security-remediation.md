# Dependency security maintenance

The October 24 maintenance update replaces the affected request parser, upload
parser, sanitizer, Electron runtime, HTTP clients, Markdown parser, mailer, URI
parser, serializer, Vite and Vitest releases. The workspace uses Zod 4.6.7 so
bounded collections reject oversized input before walking their elements. The
two hand-written record schemas and future Orval generation use the matching
record API. Existing case and billing behavior remains covered by the normal
type, API, desktop and mobile checks.

`pnpm run test:dependency-security` exercises installed dependencies, including a
separate local process proving that compressed JSON with trailing bytes does
not crash body-parser. It also tests early collection-size rejection in Zod.

## node-forge advisory exception

The only advisory exception is GHSA-86w9-cpqp-85rv for node-forge 1.4.0. There is
no compatible published upstream replacement. The tracked
`patches/node-forge@1.4.0.patch` rejects additional DigestAlgorithm elements and
invalid NULL parameters. The lockfile binds that patch by hash. The security
suite verifies that each installed consumer resolves to the patched package
and rejects malformed RSA signatures while accepting valid signatures.

CI runs those regressions before `pnpm audit --audit-level=low`; a missing,
unapplied or ineffective patch must fail the job. Do not expand the exception
to unrelated advisories. Remove it when an upstream fixed version replaces
the patch. Other tracked source patches remain installed and tested.

## Cross-platform validation

Browser jobs use Ubuntu 24.04, a supported host for the pinned Playwright release.
The desktop package declares esbuild directly for its Windows backup smoke
script. Native build-tool dependencies are no longer removed from the lockfile
for other operating systems, so Windows and macOS can install their own binaries.

Invoice parity fixtures encode issued dates as UTC calendar days, as the API
does. Custom aging selections now use the same UTC-day boundaries as the main
issued-date filter, including midnight and created-date fallback. Regression
checks cover timezones west and east of UTC.

This update does not deploy the application or publish a desktop installer.
The public desktop version endpoint follows the published updater manifest;
an unbuilt source version is not a published desktop release.
