# Provider portal startup regression

Run the desktop and API managed workflows, then:

```sh
pnpm --filter @workspace/labtrax-desktop run test:provider-browser
```

The browser check uses a persisted **synthetic** session and intercepted API
responses, not customer credentials or database writes. It enters
`/desktop/settings`, dismisses optional trial onboarding, clicks every reported
navigation/header control, checks zero-practice approval guidance and account
preferences, retries a failed organization request, confirms selection before
case loading, checks tenant headers and 390/768/1280px layouts, and signs out.
It also reloads with a saved, still-authorized practice and an assigned case
to check that the normal case table remains usable after initialization.
Set `PROVIDER_BROWSER_URL` to a different preview origin if necessary;
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select a locally installed Chromium.

Focused companion tests cover native drawer/header interactions, foreground
refresh, persisted-selection removal, selection failures, delayed outgoing
refusals, bounded startup requests, mandatory entitlement decisions, and
desktop selection/case request races. Server tests verify pending memberships
do not grant access, lab partnerships do not become practices, and revoked
practices cannot be restored.

The reported original desktop failure was reproduced with real clicks and a
pointer hit test: zero practices left every tab's main pane blank, while the
buttons still received clicks. Optional trial onboarding was visible and
dismissible; no invisible interception was found. Native zero-practice startup
instead entered its switching state indefinitely. Separate client bootstraps
also made initial selection race its case requests.

A separate mobile-web sign-out failure came from invoking the native
compressor cache API on the web. Cleanup now respects the platform and
captures synchronous native-module failures without skipping protected-file
cleanup or aborting logout.

Browser fixture tests do not prove email-verification approval, subscription
policy, or native-device behavior. An unverified real fresh account correctly
received forbidden practice requests while its canonical server subscription
was trialing. Keep those gates intact. Physical iOS/Android safe-area, keyboard
and native modal behavior require device release checks; RNTL and mobile-web
results must not be represented as physical-device evidence.
