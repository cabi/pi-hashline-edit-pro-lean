/**
 * Lean prompt text for the three lean tools, assembled from upstream
 * semantics with flag awareness mirroring upstream's prompt assembly in
 * src/edit-common.ts (with*Prompts; since 6.4.7 the shared edit guidelines
 * attach only via `replace` and pi's buildRules dedupe carries them —
 * see MAINTENANCE.md for the per-tool trim table).
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
  if (flags.outlineEnabled) ops.push("outline");
  if (flags.replaceMatchEnabled) ops.push("replace_match");
  ops.push("insert");
  if (flags.copyMoveEnabled) ops.push("copy", "move");
  ops.push("undo_last_change");
  return `Remember to use the hashline tools for every file read and edit: \`read\`, \`replace\`, and \`hashline\` (ops: ${ops.join(", ")}).`;
}

/** Upstream batchGuideline (+ codemode suffix). Word "diff/result" by autoRead. */
export function buildBatchRule(flags: EditToolFlags): string {
  const combined = flags.autoRead ? "diff" : "result";
  let rule = `\`replace\`/\`hashline\` edit ops: same-file calls in one message commit as one batch — send together the edits whose anchors you already have; an edit that needs anchors from a previous result waits for the next turn. Earlier calls reply \`In batch N (queued)\` and the last shows the combined ${combined}, and one undo reverts all. A request-invalid call (anchors, shape, or \`match\`) fails alone; a failure while the batch runs aborts it.`;
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
    : "Edit ops: anchors resolve the file; `path` is optional but must match anchor ownership when passed.";
}

export const VERBATIM_RULE =
  "`replace`/`hashline` text fields: `text` is written exactly as received; escapes are decoded once when the call is parsed, and the tool never decodes again — `\\uXXXX` is the character, `\\\\uXXXX` the literal text.";

export const DIFF_RULE =
  "Post-edit diff: `-anchor│` rows are dead; `+anchor│` and ` anchor│` rows carry live anchors for the next edit, and rows the diff does not show keep their anchors, so a follow-up edit on them needs no re-read.";

export const STRICT_INPUT_RULE =
  "Strict-input mode is on: auto-fixable slips are rejected instead of fixed with warnings.";

export const CODEMODE_CONTRACT_RULE =
  'When called from a codemode script, failures resolve to `{ ok: false, kind: "error", error: { code, message } }`; branch on `ok` instead of `try`/`catch`. Arguments that fail the tool\'s schema still throw before the tool runs.';

/** Upstream editScriptGuideline (6.4.7): the chaining half lean keeps. */
export const CODEMODE_EDIT_CHAIN_RULE =
  "Codemode edit results carry `anchors[].anchor` to chain the next edit; read again when `anchorsOmitted` is true.";

/** Upstream READ_SCRIPT_GUIDELINE (6.4.8): codemode read resolves to plain text by default. */
export const CODEMODE_READ_RESULTS_RULE =
  "`read` from a codemode script resolves to the file's text, like the built-in `read`; pass `anchors: true` for `{ text, lines, notices }` with the raw served window and `lines[].anchor` for chained edits; an image read resolves to an image block.";

/** Upstream GREP_SCRIPT_GUIDELINE (6.4.7). */
export const CODEMODE_GREP_RESULTS_RULE =
  "`grep` from a codemode script: `results[].lines[]` carry each hit's `anchor` and `text`, so a hit is editable without a fresh read.";

/** Mirrors upstream's outline codemode rule (7.1). */
export const CODEMODE_OUTLINE_RESULTS_RULE =
  "`outline` from a codemode script resolves to the served outline text (notices included); pass `anchors: true` for `{ text, lines, notices }` with editable anchors — a directory or glob returns `files: [{ path, lines, totalLines, truncated, complete }]` in place of `lines`.";
export const CODEMODE_TRANSFER_RULE =
  "`copy`/`move` from a codemode script commit on their own and never join a batch; a script cross-file `move` shows both the source and destination diffs.";

/** Shared suffix of edit-tool guideline lists. */
function editCommonRules(flags: EditToolFlags): string[] {
  const rules: string[] = [
    buildBatchRule(flags),
    buildPathRule(flags.requirePath),
  ];
  if (flags.codemode) rules.push(CODEMODE_CONTRACT_RULE, CODEMODE_EDIT_CHAIN_RULE);
  if (flags.autoRead) rules.push(DIFF_RULE);
  return rules;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function leanReadDescription(): string {
  return [
    "Read a text file and return it as `anchor│content` rows: a 5-character lowercase anchor (letters only), the `│` separator, then the line content. Address edits by anchor, not by line number or content.",
    "`offset` takes a 1-indexed line number or a served anchor; with an anchor, `limit` counts the lines returned starting at that anchor row. When the output says truncated, continue from the hinted `offset`. A stale anchor is refused with fresh context rows. Images attach visually; binary, directory, and UTF-16/UTF-32 text are rejected; an empty file returns one empty row you can edit to seed content.",
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
      "`hashline` op `replace_match` needs both boundary lines served: copy `match` from a served row or read the lines first.",
    );
  }
  if (flags.codemode) rules.push(CODEMODE_READ_RESULTS_RULE);
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
    `Replace a range of lines in a text file by anchor: \`remove_from\` and \`remove_to\` are the 5-character anchors of the first and last line to remove (\`replace_from\`/\`replace_to\` are accepted as aliases), and \`text\` is one string holding the exact replacement text, written exactly as given. For a single line use the same anchor twice; \`text: ""\` deletes the range.`,
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
  if (flags.outlineEnabled) {
    bullets.push(
      "- outline: the symbols of a file, a directory, or a glob such as `src/**/*.ts` — a `=== path (language) — N lines ===` header per file, then one `anchor│content` row per symbol whose content is the first line of its declaration. A `[limit N]` line under a row is that symbol's span: `read` with `offset` at the row's anchor and `limit` N returns exactly that symbol; `[N nested]` marks children hidden by `depth` (default 2, max 10). Rows cover top-level declarations and the members of a type or module, never a declaration inside a function body; a directory or glob gives each supported file a share of the 400-row cap (`*` and `**` both cross folders), skips files over 200KB, and stops at 400,000 source lines. Unsupported or symbol-less files fall back to a head-and-tail preview with a note, and a row clipped with a trailing `...` is not served for editing — read that line first",
    );
  }
  if (flags.replaceMatchEnabled) {
    bullets.push(
      "- replace_match: replace every occurrence of `match` with `replacement` inside the `replace_from`..`replace_to` anchor range (same anchor for one line; the two boundary lines must still match what was served, the interior is searched as on disk; `remove_from`/`remove_to` are accepted as aliases). `match` stays within one line — a single trailing line break is accepted (the line's own terminator). `replacement` may span lines: a lone line break counts as `\"\"` (deletes the match), a leading or interior break splits into lines, and new lines inherit the file's line endings. Send `match` as only the fragment that changes — never text `replacement` leaves unchanged; narrow the anchors when only some occurrences should change, and when the change covers a whole line use `replace` with the same anchor",
    );
  }
  bullets.push(
    "- insert: put `text` before or after the `anchor` line (`direction`); the anchor line stays; a trailing line break sets the newline of the last line written instead of adding a blank line, a leading break is an ordinary blank line",
  );
  if (flags.copyMoveEnabled) {
    bullets.push(
      "- copy: duplicate the `source_from`..`source_to` lines at the destination `anchor` with `direction` (the copy lands after/before it); the source stays in place and the copy is the content the source anchors were served from; the anchor may live in another file, and an empty destination file is seeded",
      "- move: relocate the `source_from`..`source_to` lines to the destination `anchor` with `direction`, which must place the block outside the range when both share a file; moving a range to where it already sits reports `No changes made`; rows between the source and the destination keep their content but may be re-anchored, so read that span again before editing it; a cross-file move records one undo entry per file, and when its source file also gets same-message edits it runs outside any batch — send it in a separate message",
    );
  }
  bullets.push(
    "- grep: ripgrep search whose hits come back as `lineNumber:│ anchor│content` rows you can edit without a new `read` (context rows are marked `lineNumber-│`); respects `.gitignore`; when cut by match limit raise `limit`, when cut by rows/bytes refine `pattern`",
    "- undo_last_change: revert a file's last edit (one slot per file, not a stack; refused if the file changed since — a file deleted since is restored; any `write` clears the slot; a cross-file move needs both sides undone)",
    "- read / replace: forward to the standalone tools of the same names",
    "- help: return the full upstream documentation and parameter list; set `about` to an op name",
  );
  const transferNote = flags.copyMoveEnabled
    ? " For a block copy/move, only the source's two boundary rows and the destination `anchor` line need serving — grep the marker lines to serve them; to append at the end, anchor that file's last served line with `direction: \"after\"`."
    : "";
  return [
    `Multi-op file-editing tool for the hashline toolset. Set \`op\` to the operation and pass that operation's parameters; all parameters are flat and optional except \`op\`. Anchors are the 5-character lowercase codes from \`anchor│content\` rows served by \`read\`.${transferNote}`,
    bullets.join("\n"),
  ].join("\n\n");
}

export function leanHashlineSnippet(flags: EditToolFlags): string {
  const ops: string[] = [];
  if (flags.outlineEnabled) ops.push("outline");
  ops.push("replace_match");
  ops.push("insert", "copy", "move", "grep", "undo_last_change", "help");
  return `File-edit ops via \`op\`: ${ops.join(", ")}`;
}

export function leanHashlineGuidelines(flags: EditToolFlags): string[] {
  const rules: string[] = [buildPreferRule(flags)];
  rules.push(
    "`grep` op: prefer it over shell `rg`/`grep` for searching so hits carry anchors and need no `read`; use `literal: true` when the pattern contains regex metacharacters.",
  );
  if (flags.outlineEnabled) {
    rules.push(
      "`outline`: before you `read` a large or unfamiliar file or module, outline it and read only the spans you need; a span starts at the declaration line — decorators above it sit outside it, so read the lines above before you delete or move a symbol.",
    );
  }
  if (flags.codemode) rules.push(CODEMODE_GREP_RESULTS_RULE);
  if (flags.codemode && flags.outlineEnabled) rules.push(CODEMODE_OUTLINE_RESULTS_RULE);
  if (flags.replaceMatchEnabled) {
    rules.push(
      "`replace_match`: every occurrence inside the anchored range is replaced, so scope the range when only some matching lines should change, and cover all the lines you do want changed in one call instead of one call per line.",
    );
  }
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
        "grep",
        "undo_last_change",
        "read",
        "outline",
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
    // replace_match (upstream 6.5.0 renamed old_string/new_string → match/replacement)
    match: { type: "string" },
    replacement: { type: "string" },
    // insert / copy / move
    anchor: { type: "string" },
    direction: { type: "string", enum: ["after", "before"] },
    text: { type: "string" },
    // copy / move (destination is `anchor` + `direction`)
    source_from: { type: "string" },
    source_to: { type: "string" },
    // read / grep / undo
    path: { type: "string" },
    offset: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string" }] },
    limit: { type: "integer", minimum: 1 },
    anchors: { type: "boolean" }, // read/outline, codemode only: structured { text, lines, notices } instead of plain text
    // outline
    depth: { type: "integer", minimum: 0, maximum: 10 },
    // grep
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
