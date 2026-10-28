# GitHub source-sync safety

The public source repository and the Replit worktree have diverged. A raw
history push is not an appropriate reconciliation: Replit's tracked history
includes private runtime material. Do not force-push it to the public mirror.

The backup helper inspects every outgoing commit before its first push. Exit
code 5 means it found a private runtime path, including one deleted from the
latest tree. Adding a .gitignore rule does not erase earlier commits. The path
check is a guard, not a complete content/secret audit.

Reconcile from a reviewed source-only snapshot based on GitHub's current branch.
Exclude production SQL/dumps, case uploads, operator reports, fingerprints,
credentials and attached assets. Preserve newer work on both platforms and
verify the exact resulting remote commit before reporting success. Do not copy
production data into fixtures to make a source-only checkout's tests pass.

A source push is not an EAS build, an App Store Connect upload, Apple processing,
or TestFlight availability. The Replit publishing entry and the repository's
EAS scripts are separate paths; a successful EAS upload does not prove that
Replit's App Store button works.
