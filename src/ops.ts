/**
 * Op-name canonicalization.
 *
 * Upstream tool names double as the `op` values of the merged `hashline`
 * tool. Models occasionally miss an underscore or add casing noise
 * ("ReplaceMatch", "anchor grep"). Normalizing here in `prepareArguments`
 * (before schema validation) is safe when the match is unique, and is left
 * untouched otherwise so validation reports the bad value.
 */

export const UPSTREAM_TOOL_NAMES = [
  "read",
  "replace",
  "replace_match",
  "insert",
  "copy",
  "move",
  "grep",
  "undo_last_change",
] as const;

export type UpstreamToolName = (typeof UPSTREAM_TOOL_NAMES)[number];

/** Ops accepted by the merged `hashline` tool (help included). */
export const HASHLINE_OPS = [
  ...UPSTREAM_TOOL_NAMES,
  "help",
] as const;

export type HashlineOp = (typeof HASHLINE_OPS)[number];

/** Standalone lean tools; these ops forward to the sibling tool. */
export const STANDALONE_TOOLS = ["read", "replace"] as const;

/**
 * Canonicalize a tool/op name against a candidate list.
 *
 * Rules: trim; strip surrounding quotes/backticks; lowercase; turn spaces
 * and dashes into underscores; drop a redundant `hashline_` prefix; exact
 * match wins; otherwise compare underscore-flattened forms (exact, then
 * unambiguous prefix/inclusion when at least 3 chars).
 *
 * Returns the canonical candidate, or the input unchanged when it is
 * empty, not a string, or not uniquely matched — the caller decides what
 * to do with the miss (schema validation or an explicit error).
 */
export function canonicalizeName(
  raw: unknown,
  candidates: readonly string[],
): string | typeof raw {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!trimmed) return raw;
  const norm = trimmed
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^hashline_+/, "");
  if (candidates.includes(norm)) return norm;
  const flat = norm.replace(/_/g, "");
  const flatCandidates = candidates.map((c) => c.replace(/_/g, ""));
  const exact = candidates.find((_, i) => flatCandidates[i] === flat);
  if (exact) return exact;
  if (flat.length >= 3) {
    const hits = candidates.filter(
      (_, i) =>
        flatCandidates[i].startsWith(flat) || flatCandidates[i].includes(flat),
    );
    if (hits.length === 1) return hits[0];
  }
  return raw;
}

/** Canonicalize `args.op` for the hashline tool; returns args untouched when no unique fix exists. */
export function canonicalizeHashlineArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const op = (args as { op?: unknown }).op;
  if (typeof op !== "string") return args;
  const canonical = canonicalizeName(op, HASHLINE_OPS);
  if (canonical !== op) return { ...(args as Record<string, unknown>), op: canonical };
  return args;
}
