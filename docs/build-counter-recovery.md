# Build Counter Recovery

When a GitHub Actions build workflow can't push the updated build counter back to
`main` (e.g. due to branch-protection rules, network problems, or a token with
insufficient permissions), the workflow now exits with a **warning** instead of a
hard failure. The installer or app bundle that was produced is still good — only
the counter file didn't make it into the repo.

To make sure the next build gets a higher number (not the same one), you need to
apply the fallback artifact — either via the one-click recovery panel in Settings,
or manually.

## One-click recovery (recommended)

Open **Settings → Desktop app** (for Windows/macOS builds) or
**Settings → Mobile app** (for EAS builds) in the LabTrax Desktop app and scroll
to the **Build counter recovery** section.

1. Open the failed GitHub Actions run summary and find the `build-number.json`
   (desktop) or `app.json` (mobile) inside the attached `build-counter-fallback`
   artifact — the correct `buildNumber` / `versionCode` value is printed there.
2. Paste that number into the **Build counter recovery** field and click
   **Apply counter**.

The API uses the **`BUILD_BOT_TOKEN`** secret (falling back to
`GITHUB_ACTIONS_TOKEN`) to commit the corrected file directly to `main` via the
GitHub Contents API, bypassing any branch-protection rules that blocked the
original push. A link to the new commit is shown on success.

> **Prerequisites:** `GITHUB_REPO_URL` must be set to your repository URL, and
> either `BUILD_BOT_TOKEN` or `GITHUB_ACTIONS_TOKEN` must have **Contents: Read &
> Write** access. If neither token is configured the panel falls back to a local
> git commit (dev-only path).

## When this applies

You'll see a yellow warning annotation on the run summary:

> All push attempts failed — build number was NOT persisted. The build artifact
> is still usable; download the build-counter-fallback workflow artifact and apply
> it manually.

A `build-counter-fallback` (or `build-counter-fallback-windows` /
`build-counter-fallback-macos` for the release workflow) artifact will be
attached to the failed run.

## Manual recovery (fallback)

### Desktop builds (build-windows, build-macos, release)

The fallback artifact contains `build-number.json`.

| Workflow | Artifact name |
|----------|---------------|
| `build-windows.yml` | `build-counter-fallback` |
| `build-macos.yml` | `build-counter-fallback` |
| `release.yml` (Windows job) | `build-counter-fallback-windows` |
| `release.yml` (macOS job) | `build-counter-fallback-macos` |

1. Open the GitHub Actions run summary and download the appropriate artifact
   from the table above (a `.zip` — extract it to find `build-number.json`).
2. Copy the extracted file over the existing one in the repo:

   ```
   artifacts/labtrax-desktop/build-number.json
   ```

3. Commit and push directly to `main` (or open a PR):

   ```bash
   git add artifacts/labtrax-desktop/build-number.json
   git commit -m "chore: apply build counter fallback from run <RUN_ID> [skip ci]"
   git push origin main
   ```

4. Verify the file on `main` has a `buildNumber` value higher than the previous
   one before triggering the next build.

### Mobile builds (eas-build)

The fallback artifact contains `app.json`.

1. Download and extract the `build-counter-fallback` artifact to get `app.json`.
2. Copy the extracted file over the existing one in the repo:

   ```
   artifacts/labtrax/app.json
   ```

3. Commit and push to `main`:

   ```bash
   git add artifacts/labtrax/app.json
   git commit -m "chore: apply mobile build counter fallback from run <RUN_ID> [skip ci]"
   git push origin main
   ```

4. Confirm `expo.ios.buildNumber` and `expo.android.versionCode` are higher than
   the values currently on `main` before triggering the next EAS build.

## Preventing future failures

The most common cause is that `GITHUB_TOKEN` lacks the "bypass branch protection"
right on a protected branch. Set the `BUILD_BOT_TOKEN` secret to a fine-grained
PAT (or GitHub App installation token) with **Contents: Read & Write** and, if
your branch has required reviews or status checks, the "allow bypass of branch
protection rules" option enabled. See the note in each workflow's checkout step
for details.
