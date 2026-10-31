/**
 * pi-hashline-edit-pro-lean
 *
 * Token-lean wrapper around pi-hashline-edit-pro (pinned exact-version
 * dependency; no upstream code copied or modified). Upstream is initialized
 * with a Proxy around the pi extension API:
 *
 * - `registerTool` is intercepted: upstream definitions are captured in a
 *   `latest` map (keep the most recent per name — upstream re-registers on
 *   config/model-gate refreshes) and never registered directly. The lean
 *   trio (`read`, `replace`, `hashline`) is registered instead, with lean
 *   descriptions/schemas but execute/render plumbing forwarded to the
 *   captured definitions.
 * - `setActiveTools` is intercepted: upstream's tool-list mutations are
 *   recorded in a shadow list (which upstream's own getActiveTools reads)
 *   and flushed to the real session once per session_start. After that the
 *   real tool list is frozen — upstream's mid-session gate/config changes
 *   keep updating the shadow and the captured definitions, while lean
 *   execute re-checks availability per call. This keeps the tool list the
 *   model sees stable for the whole session.
 * - everything else (event handlers, slash commands, write hook) passes
 *   through to the real pi object unchanged.
 *
 * The merged `hashline` tool carries the remaining upstream tools as ops
 * plus `help`, which returns the full upstream documentation and parameter
 * schema for any op. `outline` (added upstream 7.1) is opt-in: registered
 * and captured unconditionally, but its op refuses with E_LEAN_OP_DISABLED
 * until the config's Outline tool switch enables it.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import upstream from "pi-hashline-edit-pro";
import { readConfig } from "pi-hashline-edit-pro/src/config";
import {
  DEFAULT_EDIT_FLAGS,
  currentEditFlags,
  type EditToolFlags,
} from "pi-hashline-edit-pro/src/edit-common";
import { modelDisabled, type ModelLike } from "pi-hashline-edit-pro/src/model-gate";
import { structuredFailure } from "pi-hashline-edit-pro/src/structured";
import {
  canonicalizeHashlineArgs,
  canonicalizeName,
  HASHLINE_OPS,
  STANDALONE_TOOLS,
  UPSTREAM_TOOL_NAMES,
} from "./ops.ts";
import {
  HASHLINE_SCHEMA,
  leanHashlineSnippet,
  LEAN_READ_SNIPPET,
  LEAN_REPLACE_SNIPPET,
  leanHashlineDescription,
  leanHashlineGuidelines,
  leanReadDescription,
  leanReadGuidelines,
  leanReplaceDescription,
  leanReplaceGuidelines,
  stripParamDescriptions,
} from "./lean-text.ts";

type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Most recently captured upstream definition per tool name. */
const latest = new Map<string, AnyToolDefinition>();

/** Upstream's view of the active tool list (diverges from the real, frozen list mid-session). */
let shadowActive: string[] | null = null;

let realPi: ExtensionAPI | null = null;

/** Current lean prompt flags: DEFAULT_EDIT_FLAGS until the session starts. */
let leanFlags: EditToolFlags = DEFAULT_EDIT_FLAGS;

function proxyActiveTools(): string[] {
  return shadowActive ?? realPi?.getActiveTools() ?? [];
}

function isUpstreamTool(value: unknown): value is string {
  return typeof value === "string" && (UPSTREAM_TOOL_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Proxy around the pi object handed to upstream
// ---------------------------------------------------------------------------

function makeUpstreamPi(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (def: AnyToolDefinition) => {
          latest.set(def.name, def);
        };
      }
      if (prop === "setActiveTools") {
        return (names: string[]) => {
          shadowActive = [...names];
        };
      }
      if (prop === "getActiveTools") {
        return () => proxyActiveTools();
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Availability checks (config flags + model gate), evaluated per call
// ---------------------------------------------------------------------------

async function opUnavailableError(
  name: string,
  ctx: ExtensionToolContext | undefined,
): Promise<string | null> {
  const config = await readConfig();
  if (
    config.disableOnModels?.length &&
    ctx?.model &&
    modelDisabled(ctx.model as ModelLike, config.disableOnModels)
  ) {
    // With readOnDisabledModels "vanilla" upstream swaps in a plain read
    // tool under the same name, and gated models always keep a plain grep
    // under the name "grep"; the captured definitions already reflect those
    // swaps, so both stay available.
    if (
      name !== "grep" &&
      !(name === "read" && config.readOnDisabledModels === "vanilla")
    ) {
      return `[E_LEAN_MODEL_GATED] This model matches the hashline disableOnModels setting, so the ${name} operation is unavailable here; use the built-in read/edit tools instead.`;
    }
  }
  if (name === "replace_match" && config.replaceMatchEnabled === false) {
    return "[E_LEAN_OP_DISABLED] The replace_match op is turned off in the hashline config; enable it with /hashline-config or use `replace`.";
  }
  if ((name === "copy" || name === "move") && config.copyMoveEnabled === false) {
    return `[E_LEAN_OP_DISABLED] The ${name} op is turned off in the hashline config; enable it with /hashline-config.`;
  }
  if (name === "outline" && config.outlineEnabled !== true) {
    // outline is opt-in: upstream registers the tool unconditionally but
    // keeps it out of the active tools unless outlineEnabled, so the captured
    // definition would still execute — gate it here.
    return "[E_LEAN_OP_DISABLED] The outline op is turned off in the hashline config; enable it with /hashline-config.";
  }
  // No grep branch: with anchorGrepEnabled === false, or on gated models,
  // upstream swaps in pi's vanilla grep under the same "grep" name, so the op
  // stays available in either flavor.
  return null;
}

/** Forward a call to the most recently captured upstream definition. */
async function forwardExecute(
  name: string,
  toolCallId: string,
  args: any,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<any> | undefined,
  ctx: ExtensionToolContext,
): Promise<AgentToolResult<any>> {
  const def = latest.get(name);
  if (!def) {
    return structuredFailure(
      new Error("[E_LEAN_NOT_READY] The hashline toolset is still initializing; retry shortly."),
      { op: name },
    );
  }
  const unavailable = await opUnavailableError(name, ctx);
  if (unavailable) {
    return structuredFailure(new Error(unavailable), { op: name });
  }
  // Strip lean-internal fields; upstream validates and rejects unknown
  // fields itself (its own per-tool schemas), so anything else the model
  // sent reaches upstream exactly as upstream would have seen it.
  const { op: _op, about: _about, ...rest } = (args ?? {}) as Record<string, unknown>;
  const prepared = def.prepareArguments ? def.prepareArguments(rest) : rest;
  return def.execute(toolCallId, prepared, signal, onUpdate, ctx);
}

/** Tag a forwarded result so lean renderResult can dispatch to the right renderer. */
function tagLeanOp(result: AgentToolResult<any>, op: string): AgentToolResult<any> {
  if (result && typeof result === "object" && result.details && typeof result.details === "object") {
    try {
      (result.details as Record<string, unknown>).leanOp = op;
    } catch {
      // frozen/exotic details object — renderer falls back by op heuristics
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// hashline merged tool: help + op dispatch
// ---------------------------------------------------------------------------

function helpResult(aboutRaw: unknown): AgentToolResult<any> {
  const names = UPSTREAM_TOOL_NAMES as readonly string[];
  if (typeof aboutRaw === "string" && aboutRaw.trim()) {
    const canonical = canonicalizeName(aboutRaw, names);
    if (!isUpstreamTool(canonical)) {
      return structuredFailure(
        new Error(
          `[E_LEAN_HELP_ABOUT] Unknown 'about' tool name: ${JSON.stringify(aboutRaw)}. Use one of: ${names.join(", ")}.`,
        ),
        { op: "help" },
      );
    }
    const def = latest.get(canonical);
    if (!def) {
      return structuredFailure(
        new Error(`[E_LEAN_NOT_READY] No upstream definition captured for ${canonical} yet; retry shortly.`),
        { op: "help" },
      );
    }
    const parts: string[] = [
      `# hashline op \`${canonical}\` — full upstream documentation`,
      "",
      "## description",
      String(def.description),
      "",
      "## parameters",
      "```json",
      JSON.stringify(def.parameters, null, 2),
      "```",
    ];
    if (def.promptSnippet) parts.push("", "## promptSnippet", String(def.promptSnippet));
    if (def.promptGuidelines?.length) {
      parts.push("", "## promptGuidelines", ...def.promptGuidelines.map((g) => `- ${g}`));
    }
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: { leanHelp: canonical },
    };
  }
  const lines = names.map((n) => `- ${n}: ${latest.get(n)?.promptSnippet ?? ""}`);
  return {
    content: [
      {
        type: "text",
        text: `hashline ops — set 'about' to one of: ${names.join(", ")}.\n${lines.join("\n")}`,
      },
    ],
    details: { leanHelp: "list" },
  };
}

async function hashlineExecute(
  toolCallId: string,
  args: any,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<any> | undefined,
  ctx: ExtensionToolContext,
): Promise<AgentToolResult<any>> {
  const op = canonicalizeName(args?.op, HASHLINE_OPS);
  if (op === "help") return helpResult(args?.about);
  if (isUpstreamTool(op)) {
    const result = await forwardExecute(op, toolCallId, args, signal, onUpdate, ctx);
    return tagLeanOp(result, op);
  }
  return structuredFailure(
    new Error(
      `[E_LEAN_OP] Missing or unknown 'op'. Use one of: ${HASHLINE_OPS.join(", ")} — or set 'op' to 'help' for full documentation.`,
    ),
    { op: typeof op === "string" ? op : null },
  );
}

// ---------------------------------------------------------------------------
// Lean tool definitions
// ---------------------------------------------------------------------------

function buildLeanReadDef(): AnyToolDefinition {
  const captured = latest.get("read");
  const def: AnyToolDefinition = {
    name: "read",
    label: captured?.label ?? "read",
    description: leanReadDescription(),
    promptSnippet: LEAN_READ_SNIPPET,
    promptGuidelines: leanReadGuidelines(leanFlags),
    parameters: captured
      ? stripParamDescriptions(captured.parameters)
      : { type: "object", additionalProperties: true },
    execute: (id, args, signal, onUpdate, ctx) =>
      forwardExecute("read", id, args, signal, onUpdate, ctx),
  };
  if (captured?.outputSchema) def.outputSchema = captured.outputSchema;
  if (captured?.executionMode) def.executionMode = captured.executionMode;
  if (captured?.prepareArguments) {
    def.prepareArguments = (args: unknown) => captured.prepareArguments!(args);
  }
  if (captured?.renderCall) {
    def.renderCall = (args: any, theme: any, context: any) =>
      latest.get("read")?.renderCall?.(args, theme, context) ?? new Text("", 0, 0);
  }
  if (captured?.renderResult) {
    def.renderResult = (result: any, options: any, theme: any, context: any) =>
      latest.get("read")?.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
  }
  return def;
}

function buildLeanReplaceDef(): AnyToolDefinition {
  const captured = latest.get("replace");
  const def: AnyToolDefinition = {
    name: "replace",
    label: captured?.label ?? "replace",
    description: leanReplaceDescription(leanFlags),
    promptSnippet: LEAN_REPLACE_SNIPPET,
    promptGuidelines: leanReplaceGuidelines(leanFlags),
    parameters: captured
      ? stripParamDescriptions(captured.parameters)
      : { type: "object", additionalProperties: true },
    execute: (id, args, signal, onUpdate, ctx) =>
      forwardExecute("replace", id, args, signal, onUpdate, ctx),
  };
  if (captured?.outputSchema) def.outputSchema = captured.outputSchema;
  if (captured?.executionMode) def.executionMode = captured.executionMode;
  if (captured?.prepareArguments) {
    def.prepareArguments = (args: unknown) => captured.prepareArguments!(args);
  }
  if (captured?.renderCall) {
    def.renderCall = (args: any, theme: any, context: any) =>
      latest.get("replace")?.renderCall?.(args, theme, context) ?? new Text("", 0, 0);
  }
  if (captured?.renderResult) {
    def.renderResult = (result: any, options: any, theme: any, context: any) =>
      latest.get("replace")?.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
  }
  return def;
}

/** Union of the merged tools' captured outputSchemas (codemode structured output). */
function mergedOutputSchema(): Record<string, unknown> | undefined {
  const schemas = (
    ["replace_match", "insert", "copy", "move", "grep", "outline", "undo_last_change"] as const
  )
    .map((n) => latest.get(n)?.outputSchema)
    .filter((s): s is NonNullable<unknown> => Boolean(s));
  if (!schemas.length) return undefined;
  return { anyOf: schemas };
}

function textOfResult(result: any): string {
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) {
    return result.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  }
  return "";
}

function hashlineRenderCall(args: any, theme: any, context: any): any {
  const op = canonicalizeName(args?.op, HASHLINE_OPS);
  const def = isUpstreamTool(op) ? latest.get(op) : undefined;
  if (def?.renderCall) return def.renderCall(args, theme, context);
  return new Text(`hashline ${typeof args?.op === "string" ? args.op : "(no op)"}`, 0, 0);
}

function hashlineRenderResult(result: any, options: any, theme: any, context: any): any {
  const op = result?.details?.leanOp;
  const def = isUpstreamTool(op) ? latest.get(op) : undefined;
  const renderer = def?.renderResult ?? latest.get("replace")?.renderResult;
  if (renderer) return renderer(result, options, theme, context);
  return new Text(textOfResult(result), 0, 0);
}

function buildLeanHashlineDef(): AnyToolDefinition {
  const def: AnyToolDefinition = {
    name: "hashline",
    label: "hashline",
    description: leanHashlineDescription(leanFlags),
    promptSnippet: leanHashlineSnippet(leanFlags),
    promptGuidelines: leanHashlineGuidelines(leanFlags),
    parameters: HASHLINE_SCHEMA as any,
    executionMode: "sequential",
    prepareArguments: canonicalizeHashlineArgs,
    execute: hashlineExecute,
    renderCall: hashlineRenderCall,
    renderResult: hashlineRenderResult,
  };
  const merged = mergedOutputSchema();
  if (merged) def.outputSchema = merged as any;
  return def;
}

function registerLeanTools(pi: ExtensionAPI): void {
  pi.registerTool(buildLeanReadDef());
  pi.registerTool(buildLeanReplaceDef());
  pi.registerTool(buildLeanHashlineDef());
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function leanExtension(pi: ExtensionAPI): void {
  realPi = pi;
  const upstreamPi = makeUpstreamPi(pi);

  // Upstream registers its tools (captured), handlers, and commands here.
  upstream(upstreamPi);

  // Lean trio with pre-session default texts; refreshed with config-aware
  // texts at session_start. registerTool replaces by name, so the tool
  // list the model sees never changes mid-session.
  registerLeanTools(pi);

  // Registered after upstream's own session_start handler, so this runs
  // after upstream has refreshed its definitions and computed the
  // session's tool list. Flushes upstream's list to the real session
  // once; later upstream list changes stay in the shadow.
  pi.on("session_start", async () => {
    const codemodeActive = proxyActiveTools().includes("codemode");
    leanFlags = await currentEditFlags(codemodeActive);
    registerLeanTools(pi);
    if (shadowActive) {
      // Drop "grep" from the flushed list: upstream's grep registration is
      // captured, never forwarded, so the name would resolve to pi's built-in
      // vanilla grep and compete with the hashline `grep` op. The op itself
      // forwards to the correct captured flavor (anchored or vanilla).
      // (outline is likewise exposed as a hashline op, never a standalone
      // tool, so its name is dropped with grep when Outline tool is on.)
      pi.setActiveTools(shadowActive.filter((n) => n !== "grep" && n !== "outline"));
    }
  });
}

/** Test hook: clear the module-level proxy state (fresh-process semantics). */
export function __resetLeanStateForTests(): void {
  latest.clear();
  shadowActive = null;
  realPi = null;
  leanFlags = DEFAULT_EDIT_FLAGS;
}
