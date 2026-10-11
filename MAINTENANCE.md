# MAINTENANCE

## Upstream version

Pinned to `pi-hashline-edit-pro@6.3.1` (exact pin, no `^`) in `package.json`. Upstream is a regular dependency: never copied, never patched; `node_modules` must stay untouched.

## What was trimmed, per tool

Upstream originals are captured in `upstream-inventory.json` (regenerate with `npx tsx scripts/inventory.ts`). Lean texts live in `src/lean-text.ts` and are flag-aware (config/codemode), mirroring upstream's prompt assembly in `src/edit-common.ts` (`finalizePrompts`).

- **read** (upstream 1740 ch): kept how anchors work, `offset`/`limit` usage, the always-anchor/never-JSON facts, and the no-anchors-means-gated-model note. Dropped repetition of schema types, UI-only notes, and re-explanations of replace semantics.
- **replace** (2696 ch): kept the anchor-form contract, `text` replaces `old_string` exactly, auto-strip when `text` equals the line, `_NO_MATCH_`/`_REMOVED_` sentinels, and the `replace_match` boundary rule (only when that tool is enabled). Dropped prose restating parameter types and shared how-anchors-work text.
- **hashline** (merged; replaces `replace_match` 2949 + `insert` 2309 + `copy` 2797 + `move` 2664 + `anchor_grep` 2040 + `undo_last_change` 1207 ch): one-line bullets per op, disabled ops omitted from the text; boundary-row and append-at-end notes for copy/move kept. Full originals remain available to the model via `op: help`.
- Parameter schemas: `src/index.ts` `stripParamDescriptions()` walks the captured TypeBox schema and deletes `description` keys only — types, enums, bounds, and required stay. The merged tool keeps every field optional (union of upstream fields) so validation is upstream's job per op; upstream rejects unknown fields with `[E_BAD_SHAPE]`, same as its per-tool schemas.
- Guidelines: 22 deduped upstream rules → 9 lean rules. Kept every rule that changes how the model calls the tools (batching same-file edits, verbatim text/no escape decoding, path rules per `requirePath`, diff reading rules when auto-read is on, codemode contract/transfer/undo rules, strict-input mode note).

## Upstream internals this package depends on

1. **Registered tool names** (`read`, `replace`, `replace_match`, `insert`, `copy`, `move`, `anchor_grep`, `undo_last_change`; `src/index.ts` registers lean `read`/`replace` under the same names so upstream's session write-hook batching and undo registry keep matching).
2. **`registerTool` replace-by-name semantics + upstream's re-registration waves** (`index.ts` `refreshEditTools`, the model-gate vanilla-read swap): the Proxy captures every wave into `latest`; lean `execute` always forwards to the most recent definition, so config refreshes and the vanilla `read` swap survive without list changes.
3. **`prepareArguments` contract**: pi runs it before schema validation; lean canonicalizes `op` there, then applies the upstream tool's own `prepareArguments` (anchor-row prefix stripping, `remove_from`↔`replace_from` aliases) inside `forwardExecute` after stripping `op`/`about` (upstream rejects unknown fields, `[E_BAD_SHAPE]`).
4. **Event flow**: lean's `session_start` handler is registered after upstream's, so it runs after; it re-reads `currentEditFlags()` and flushes the shadowed `setActiveTools` list exactly once per session start.
5. **`setActiveTools` call sites** (session_start filtering, `syncModelGate` on `model_select`/`before_agent_start`, config-UI toggles): all captured into the shadow list; `getActiveTools` serves the shadow to upstream so its own logic stays consistent while the real list stays frozen.
6. **Config flags → prompt assembly**: `src/config.ts` `readConfig()` (no cache) at execute time gates disabled ops (`replaceMatchEnabled`, `copyMoveEnabled`, `anchorGrepEnabled`); `src/edit-common.ts` `currentEditFlags(codemode)` at session start picks guideline variants; `src/model-gate.ts` `modelDisabled()` + `ctx.model` at execute time enforces `disableOnModels`.
7. **Deep imports** `pi-hashline-edit-pro/src/{config,edit-common,model-gate}.ts` — possible because upstream's `package.json` has no `exports` field. If upstream adds `exports`, switch to whatever public surface replaces them.
8. **`AgentToolResult.details`**: lean stashes `details.leanOp` to dispatch `renderCall`/`renderResult` to the captured upstream renderer of that op.
9. **`structuredFailure`** from `src/structured.ts` for error parity (isError + `structuredContent.error.code`) and **`outputSchema`** merged as an `anyOf` of the captured per-op schemas so codemode keeps getting structured results.
10. **pi framework behavior**: declarations sent to the model are `{name, description, parameters}` only (`outputSchema` is free); `buildRules` dedupes identical guideline strings; prepare → validate → execute order.

## Known deviations (deliberate)

- **Frozen tool list under the model gate**: upstream removes gated tools via `setActiveTools`; lean keeps them visible and refuses at execute time with `E_LEAN_MODEL_GATED` (read serves the vanilla definition when `readOnDisabledModels: "vanilla"`). This is step 6 of the lean spec ("the tool list must not change mid-session").
- **Config-UI mid-session text changes** (requirePath/strictInput toggles rewrite upstream descriptions live): lean texts are frozen for the session and refresh at the next `session_start`; execution-level toggles apply immediately.

## How to upgrade

1. Bump the pin in `package.json` and `npm install`.
2. `npm run typecheck` — catches breaks in the deep imports and extension API.
3. `npx tsx scripts/inventory.ts`, then diff the new capture against `upstream-inventory.json` (tool set, names, descriptions, snippets, guidelines, schemas, flags). Commit the regenerated file.
4. Update `src/lean-text.ts` and the schema union in `src/lean-text.ts`/`src/ops.ts` if upstream renamed fields, changed call-affecting rules, or added/removed tools. Keep the trimming rules from the lean spec (each thing once; no restating what the schema says; keep call-affecting rules).
5. `npm test` — the per-op forwarding, gated-model, and frozen-list tests fail loudly if registration or event flow changed.
6. `npm run measure` and update the table in `README.md`.
7. Update the version above and the trim notes in this file.
