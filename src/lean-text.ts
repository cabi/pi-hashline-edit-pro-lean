/**
 * Lean prompt text for the three lean tools, assembled from upstream
 * semantics with flag awareness mirroring upstream's finalizePrompts
 * (see MAINTENANCE.md for the per-tool trim table).
 *
 * Everything here is re-worded, not copied: one statement per rule, no
 * type/enum repetition (the schema carries that), no caps emphasis, no
 * usage thresholds the user should decide.
 */

import type { EditToolFlags } from "pi-hashline-edit-pro/src/edit-common";

// ---------------------------------------------------------------------------
// Shared rules (deduped by pi's buildRules when identical across tools)
// ---------------------------------------------------------------------------

/** Upstream preferenceGuideline, pointing at the lean tool set. */
export function buildPreferRule(flags: EditToolFlags): string {
  const ops: string[] = [];
  if (flags.replaceMatchEnabled) ops.push("replace_match");
  ops.push("insert");
  if (flags.copyMoveEnabled) ops.push("copy", "move");
  ops.push("undo_last_change");
  return `Prefer the hashline tools for anything that touches files: \`read\`, \`replace\`, and \`hashline\` (ops: ${ops.join(", ")}).`;
}

/** Upstream batchGuideline (+ codemode suffix). Word "diff/result" by autoRead. */
export function buildBatchRule(flags: EditToolFlags): string {
  const combined = flags.autoRead ? "diff" : "result";
  let rule = `\`replace\`/\`hashline\` edit ops: same-file calls in one message are grouped into one batch; earlier calls reply \`In batch N (queued)\` and the last applied call shows the combined ${combined}, with one undo for the whole batch. A call whose own request is invalid fails on its own; any failure once the batch runs aborts the whole batch.`;
  if (flags.codemode) {
    rule +=
      " Calls from a codemode script apply immediately in order, and only the most recent edit per file is undoable.";
  }
  return rule;
}

/** Upstream pathGuideline, variant by requirePath. */
export function buildPathRule(requirePath: boolean): string {
  return requirePath
    ? "Edit ops: pass `path` matching the file the anchors were served for; it is required and must match anchor ownership."
    : "Edit ops: path resolution is anchor-only; do not pass `path`.";
}

export const VERBATIM_RULE =
  "`replace`/`hashline` text fields: write the character itself, not an escape; the tool writes the text verbatim and never decodes escapes — `\\uXXXX` is the character, `\\\\uXXXX` the literal text.";

export const DIFF_RULE =
  "Post-edit diff: `-anchor│` rows are dead anchors; `+anchor│` and ` anchor│` rows are live anchors for the next edit.";

export const STRICT_INPUT_RULE =
  "Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.";

export const CODEMODE_CONTRACT_RULE =
  'When called from a codemode script, failures resolve to `{ ok: false, kind: "error", error: { code, message } }`; branch on `ok` instead of `try`/`catch`.';

export const CODEMODE_TRANSFER_RULE =
  "`copy`/`move` from a codemode script commit on their own and never join a batch; a script cross-file `move` shows both the source and destination diffs.";

/** Shared suffix of edit-tool guideline lists. */
function editCommonRules(flags: EditToolFlags): string[] {
  const rules: string[] = [
    buildBatchRule(flags),
    buildPathRule(flags.requirePath),
  ];
  if (flags.codemode) rules.push(CODEMODE_CONTRACT_RULE);
  if (flags.autoRead) rules.push(DIFF_RULE);
  return rules;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function leanReadDescription(): string {
  return [
    "Read a text file and return it as `anchor│content` rows: a 4-character anchor (letters only, case-sensitive), the `│` separator, then the line content. Address edits by anchor, not by line number or content.",
    "`offset` takes a 1-indexed line number or a served anchor; with an anchor, `limit` counts lines to return after it. When the output says truncated, continue from the hinted `offset`. A stale anchor is refused with fresh context rows. Images attach visually; binary, directory, and UTF-16/UTF-32 text are rejected; an empty file returns one empty row you can edit to seed content.",
    "If the output comes back without anchors, hashline editing is disabled for this model.",
  ].join("\n\n");
}

export const LEAN_READ_SNIPPET =
  "Read a file; lines come back as `anchor│content` rows for anchored editing";

export function leanReadGuidelines(flags: EditToolFlags): string[] {
  const rules: string[] = [buildPreferRule(flags)];
  rules.push(
    "`read` again after an edit only for anchors you still lack — post-edit diff `+anchor│`/` anchor│` rows and any served `anchor│content` rows already carry fresh anchors for the changed range.",
  );
  if (flags.replaceMatchEnabled) {
    rules.push(
      "`hashline` op `replace_match` needs both boundary lines served: copy `old_string` from a served row or read the lines first.",
    );
  }
  return rules;
}

// ---------------------------------------------------------------------------
// replace
// ---------------------------------------------------------------------------

export function leanReplaceDescription(flags: EditToolFlags): string {
  const matchHint = flags.replaceMatchEnabled
    ? " To change only part of a line without retyping the rest, use `hashline` op `replace_match`."
    : "";
  return [
    `Replace a range of lines in a text file by anchor: \`remove_from\` and \`remove_to\` are the 4-character anchors of the first and last line to remove (\`replace_from\`/\`replace_to\` are accepted as aliases), and \`text\` is one string holding the exact replacement text, written exactly as given. For a single line use the same anchor twice; \`text: ""\` deletes the range.`,
    `Deleting every line empties the file, and the result names the new empty-line anchor, so a follow-up \`replace\` on it can seed content without a \`read\`.${matchHint}`,
  ].join("\n\n");
}

export const LEAN_REPLACE_SNIPPET =
  "Replace lines by anchor: `remove_from`/`remove_to` + the exact replacement `text`";

export function leanReplaceGuidelines(flags: EditToolFlags): string[] {
  const rules: string[] = [
    buildPreferRule(flags),
    "`replace`: same-message calls must target disjoint ranges; for a single line use the same anchor for `remove_from` and `remove_to`; a pure deletion (`text: \"\"`) is the cheap way to clear a large range — it verifies only the boundary lines and removes the interior as it currently stands.",
    ...editCommonRules(flags),
    VERBATIM_RULE,
  ];
  if (flags.strictInput) rules.push(STRICT_INPUT_RULE);
  return rules;
}

// ---------------------------------------------------------------------------
// hashline (merged tool)
// ---------------------------------------------------------------------------

export function leanHashlineDescription(flags: EditToolFlags): string {
  const bullets: string[] = [];
  if (flags.replaceMatchEnabled) {
    bullets.push(
      "- replace_match: replace every occurrence of `old_string` with `new_string` inside the `replace_from`..`replace_to` anchor range (same anchor for one line; the two boundary lines must still match what was served, the interior is matched as on disk; `remove_from`/`remove_to` are accepted as aliases)",
    );
  }
  bullets.push(
    "- insert: put `text` before or after the `anchor` line (`direction`); the anchor line stays; a trailing line break sets the newline of the last line written instead of adding a blank line, a leading break is an ordinary blank line",
  );
  if (flags.copyMoveEnabled) {
    bullets.push(
      "- copy: duplicate the `source_from`..`source_to` lines after `insert_after`; the source stays in place and the copy is the content the source anchors were served from; anchors may resolve to another file, and an empty destination file is seeded",
      "- move: relocate the `source_from`..`source_to` lines after `insert_after`, which must sit outside the range when both share a file; moving a range to where it already sits reports `No changes made`; a cross-file move records one undo entry per file",
    );
  }
  bullets.push(
    "- anchor_grep: ripgrep search whose hits come back as `lineNumber │ anchor│content` rows you can edit without a new `read`; respects `.gitignore`; when cut by match limit raise `limit`, when cut by rows/bytes refine `pattern`",
    "- undo_last_change: revert a file's last edit (one slot per file, not a stack; refused if the file changed since — a file deleted since is restored; any `write` clears the slot; a cross-file move needs both sides undone)",
    "- read / replace: forward to the standalone tools of the same names",
    "- help: return the full upstream documentation and parameter list; set `about` to an op name",
  );
  const transferNote = flags.copyMoveEnabled
    ? " For a block copy/move, only the source's two boundary rows and the destination line need serving; to append at the end, use the destination's last served line as `insert_after`."
    : "";
  return [
    `Multi-op file-editing tool for the hashline toolset. Set \`op\` to the operation and pass that operation's parameters; all parameters are flat and optional except \`op\`. Anchors are the 4-character codes from \`anchor│content\` rows served by \`read\`.${transferNote}`,
    bullets.join("\n"),
  ].join("\n\n");
}

export const LEAN_HASHLINE_SNIPPET = (() => {
  const ops: string[] = [];
  ops.push("replace_match");
  ops.push("insert", "copy", "move", "anchor_grep", "undo_last_change", "help");
  return `File-edit ops via \`op\`: ${ops.join(", ")}`;
})();

export function leanHashlineGuidelines(flags: EditToolFlags): string[] {
  const rules: string[] = [buildPreferRule(flags)];
  rules.push(
    "`anchor_grep`: prefer it over shell `rg`/`grep` for searching so hits carry anchors and need no `read`; use `literal: true` when the pattern contains regex metacharacters.",
  );
  rules.push(...editCommonRules(flags));
  if (flags.codemode && flags.copyMoveEnabled) rules.push(CODEMODE_TRANSFER_RULE);
  rules.push(VERBATIM_RULE);
  if (flags.strictInput) rules.push(STRICT_INPUT_RULE);
  return rules;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Parameters for the merged `hashline` tool: union of upstream parameter
 * sets, field names/types/constraints kept, descriptions dropped (the
 * description's per-op bullets and `help` carry them).
 */
export const HASHLINE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["op"],
  properties: {
    op: {
      type: "string",
      enum: [
        "replace_match",
        "insert",
        "copy",
        "move",
        "anchor_grep",
        "undo_last_change",
        "read",
        "replace",
        "help",
      ],
    },
    about: { type: "string" },
    // replace / replace_match
    remove_from: { type: "string" },
    remove_to: { type: "string" },
    replace_from: { type: "string" },
    replace_to: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
    // insert
    anchor: { type: "string" },
    direction: { type: "string", enum: ["after", "before"] },
    text: { type: "string" },
    // copy / move
    source_from: { type: "string" },
    source_to: { type: "string" },
    insert_after: { type: "string" },
    // read / anchor_grep / undo
    path: { type: "string" },
    offset: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string" }] },
    limit: { type: "integer", minimum: 1 },
    // anchor_grep
    pattern: { type: "string" },
    glob: { type: "string" },
    ignoreCase: { type: "boolean" },
    literal: { type: "boolean" },
    context: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * Recursively drop `description` fields from a JSON schema, keeping
 * names, types, enums, and constraints. Used on captured upstream schemas.
 */
export function stripParamDescriptions(schema: unknown): any {
  if (Array.isArray(schema)) return schema.map(stripParamDescriptions);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "description") continue;
      out[key] = stripParamDescriptions(value);
    }
    return out;
  }
  return schema;
}
