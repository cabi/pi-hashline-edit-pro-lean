# pi-hashline-edit-pro-lean

A token-lean front for [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro). **Based on pi-hashline-edit-pro by RimuruW and Yugimob** — every feature is theirs, unchanged and used as a pinned npm dependency (`pi-hashline-edit-pro@6.5.1`). This package only shortens the tool descriptions and schemas the model reads on every request. The original MIT license is kept (see `LICENSE`).
The lean-wrapper approach comes from [Make your own lean version](https://github.com/kunkun9527/my-lean-pi-setup/blob/main/docs/make-your-own-lean.md) in [kunkun9527/my-lean-pi-setup](https://github.com/kunkun9527/my-lean-pi-setup) — the source of the idea, with the reasoning and side-by-side examples in the article [Cut 91% of your tool prompts: a practical guide for Pi Agent users and extension authors](https://dev.to/shengkai_su/cut-91-of-your-tool-prompts-a-practical-guide-for-pi-agent-users-and-extension-authors-4jo9).

## What changes for the model

Upstream registers 8 tools. Lean registers 3 and keeps all functionality:

| Lean tool | Covers |
|---|---|
| `read` | upstream `read` (anchor-served file reading) |
| `replace` | upstream `replace` (the hot path — same-file single-line edits) |
| `hashline` | `replace_match`, `insert`, `copy`, `move`, `grep`, `undo_last_change` via an `op` parameter, plus `op: help` returning the full upstream documentation and parameter schema for any tool |

Call arguments are forwarded verbatim to the matching upstream tool; the upstream validation and behavior are untouched. Common mistakes are auto-corrected only when unambiguous: `op: "Insert"` / `"replace-match"` / `"Grep"` become `insert` / `replace_match` / `grep`; anything ambiguous (e.g. `"rep"`) is rejected by the schema's enum with the valid options listed. `op: "read"` and `op: "replace"` also forward to the standalone tools.

## What changes for the session

- **The tool list never changes mid-session.** Upstream calls to `setActiveTools` (model gate, config-UI toggles) are captured in a shadow list; the real session list is flushed once at `session_start` with the tool set upstream wants there, minus the name `grep` — upstream's grep registration is captured like the rest, so the name would resolve to pi's built-in vanilla grep and compete with the hashline `grep` op. Ops disabled by config or by the model gate (`disableOnModels`) stay visible and return a clear error instead — see the deviation note in `MAINTENANCE.md`. The `grep` op never errors: when `anchorGrepEnabled` is off or the model is gated, upstream swaps in pi's vanilla grep under the same name and the op forwards to it.
- Config flags still shape the lean texts at session start (`requirePath`, `strictInput`, codemode contract, auto-read diffs), and mid-session config changes still take effect for execution on the next call.

## Token cost

Measured on the real registered definitions (default config) with the same rendering pi uses per request — tool declarations (`{name, description, parameters}`), prompt snippets, and guidelines deduplicated across tools like pi's `buildRules` — using `js-tiktoken` (`o200k_base`). Re-run with `npm run measure`.

| | upstream 6.5.1 | lean | saved |
|---|---|---|---|
| active tools | 8 | 3 | 5 (62.5%) |
| declarations | 2003 tokens | 1296 tokens | 707 tokens (35.3%) |
| snippets | 73 tokens | 73 tokens | 0 |
| guidelines | 25 rules / 1052 tokens | 10 rules / 506 tokens | 15 rules / 546 tokens (51.9%) |
| **total per request** | **3293 tokens** | **1875 tokens** | **1418 tokens (43.1%)** |

## Use

Install as a pi package from git:

```bash
# personal install → ~/.pi/agent/settings.json
pi install git:github.com/cabi/pi-hashline-edit-pro-lean

# project install → .pi/settings.json (loaded after project trust)
pi install --local git:github.com/cabi/pi-hashline-edit-pro-lean

# try once without persisting
pi -e git:github.com/cabi/pi-hashline-edit-pro-lean
```

Alternatively, install alongside `@earendil-works/pi-coding-agent` and enable this extension instead of (or — not recommended — in addition to) upstream's:

```json
{ "pi": { "extensions": ["./node_modules/pi-hashline-edit-pro-lean/src/index.ts"] } }
```

## Keeping up with upstream

Pin the upstream version and upgrade by hand. The process is nearly always the same, so you can hand it to an agent too (this is the sync prompt from [Make your own lean version](https://github.com/kunkun9527/my-lean-pi-setup/blob/main/docs/make-your-own-lean.md), with this package's names filled in):

```text
Sync pi-hashline-edit-pro-lean to the latest version of upstream pi-hashline-edit-pro.

1. Read MAINTENANCE.md first to understand the current upstream version and adaptation points.
2. Check the latest upstream version. Compare the code and changelog between the two versions, and list: added or removed tools, changes to parameters and defaults, behavior changes, and whether the internals recorded in MAINTENANCE.md still hold.
3. If only the version number changed and the code didn't, just upgrade the dependency.
4. For new parameters or tools, add them to the lean version using the same trimming rules: common ones go in the schema, rare ones go in help. If upstream changed behavior, update the descriptions so they still match what the tool does.
5. Run the tests, re-measure the tokens, and update the README and MAINTENANCE.md.
6. Summarize the changes for me, and only publish after I confirm.
```

Most upstream updates only change internal logic, so upgrading the dependency is all it takes. When the adapter does need changes, it's usually because upstream renamed a tool or changed parameters.

## Development

```sh
npm install
npm test        # 28 tests: op forwarding, help, fill-ins, frozen list, gates
npm run typecheck
npm run measure # refreshes the table above
```

Trimming rules and upgrade guidance live in `MAINTENANCE.md`.
