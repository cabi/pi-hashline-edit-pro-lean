# Agent instructions

## Publishing — read this before any release work

- **NEVER run `npm publish` for this package.** It is not distributed via npm. Do not suggest it, do not offer it as a next step, do not "prepare" anything for npm. This rule is absolute and survives any summary or precedent: distribution is GitHub-only.
- The only publish flow, and only after the user explicitly confirms: commit the sync (lean version bump included, message `Sync to pi-hashline-edit-pro X.Y.Z`), create a **lightweight** tag `v<lean-version>`, push `main` + tag, then `gh release create` titled `v<lean> — upstream <upstream>` with notes in the format of the previous releases. Fix-only releases skip the GitHub release (like v0.7.1). Full procedure: MAINTENANCE.md, "How to upgrade".

## General

- Read MAINTENANCE.md before syncing upstream — it records the pinned version, the trimming rules, and the internals this adapter depends on.
