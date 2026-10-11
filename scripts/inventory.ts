/**
 * Inventory of what upstream pi-hashline-edit-pro registers.
 * Captures every registerTool/setActiveTools call and measures the text
 * the model reads on every request: description + input_schema (tool
 * declaration), promptSnippet and promptGuidelines (system prompt).
 */
import upstream from "pi-hashline-edit-pro";
import { encodingForModel } from "js-tiktoken";

const enc = encodingForModel("gpt-4o"); // o200k_base tokenizer

type Def = {
  name: string;
  defaultActive?: boolean;
  executionMode?: string;
  description: string;
  promptSnippet?: string | string[];
  promptGuidelines?: string | string[];
  parameters?: unknown;
  [k: string]: unknown;
};

const captured: Def[] = [];
const activeCalls: unknown[][] = [];
const events: string[] = [];

const pi: any = {
  cwd: process.cwd(),
  registerTool: (def: Def) => {
    captured.push(def);
  },
  registerCommand: (_nameOrDef: unknown) => {},
  on: (ev: string) => {
    events.push(ev);
  },
  setActiveTools: (tools: unknown[]) => {
    activeCalls.push(tools);
  },
  getActiveTools: () => [],
};

const tok = (s: string) => enc.encode(s).length;
const asText = (v?: string | string[]) =>
  v === undefined ? "" : Array.isArray(v) ? v.join("\n") : v;

(async () => {
  const init = upstream(pi as never);
  await (init as unknown as Promise<unknown>);

  console.log("== events subscribed =="); 
  console.log(events.join(", "));
  console.log("== setActiveTools calls ==");
  for (const c of activeCalls) {
    console.log(
      "[" + c.map((t: any) => (typeof t === "string" ? t : t?.name ?? t)).join(", ") + "]"
    );
  }
  console.log("== registered tools ==");
  const rows: string[] = [];
  let tDesc = 0,
    tTok = 0;
  for (const def of captured) {
    const desc = def.description ?? "";
    const snippet = asText(def.promptSnippet);
    const guide = asText(def.promptGuidelines);
    const schema = def.parameters ? JSON.stringify(def.parameters) : "";
    const all = desc + snippet + guide + schema;
    const row = {
      name: def.name,
      defaultActive: def.defaultActive,
      executionMode: def.executionMode,
      desc: desc.length + "ch/" + tok(desc) + "t",
      snippet: snippet.length + "ch/" + tok(snippet) + "t",
      guidelines: guide.length + "ch/" + tok(guide) + "t",
      schema: schema.length + "ch/" + tok(schema) + "t",
      TOTAL: all.length + "ch/" + tok(all) + "t",
    };
    rows.push(JSON.stringify(row));
    tDesc += all.length;
    tTok += tok(all);
  }
  console.log(rows.join("\n"));
  console.log("== totals ==");
  console.log("chars " + tDesc + " tokens " + tTok);

  // dump full texts for trimming work
  const dump = captured.map((d) => ({
    name: d.name,
    defaultActive: d.defaultActive,
    executionMode: d.executionMode,
    description: d.description,
    promptSnippet: d.promptSnippet,
    promptGuidelines: d.promptGuidelines,
    parameters: d.parameters,
    hasRenderCall: typeof d.renderCall === "function",
    hasRenderResult: typeof d.renderResult === "function",
    hasOutputSchema: !!d.outputSchema,
    hasPrepareArguments: !!d.prepareArguments,
  }));
  const fs = await import("node:fs");
  fs.writeFileSync(
    new URL("../upstream-inventory.json", import.meta.url),
    JSON.stringify(dump, null, 2)
  );
})();
