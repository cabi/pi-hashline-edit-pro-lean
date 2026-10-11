/**
 * Token measurement: upstream pi-hashline-edit-pro vs pi-hashline-edit-pro-lean.
 *
 * Measures what the model reads on every request when the tools are ACTIVE:
 *   1. tool declarations   -> JSON.stringify({ name, description, parameters })
 *                             (mirrors pi's toToolDeclaration; outputSchema is
 *                             never sent to the model)
 *   2. prompt snippets     -> one "- name: snippet" line per tool
 *   3. prompt guidelines   -> one "- rule" bullet per tool, deduplicated across
 *                             tools exactly like pi's buildRules()
 *
 * Uses the same Harness the tests use, so the numbers reflect the real
 * registered definitions, not hand-maintained copies.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodingForModel } from "js-tiktoken";
import upstream from "pi-hashline-edit-pro";
import lean from "../src/index.ts";
import { Harness, makeCtx } from "../test/harness.ts";

const enc = encodingForModel("gpt-4o");

const freshHome = mkdtempSync(join(tmpdir(), "lean-measure-home-"));
const freshWork = mkdtempSync(join(tmpdir(), "lean-measure-work-"));
process.env.PI_HASHLINE_DIR = freshHome;

type AnyDef = { name: string; description: string; promptSnippet?: string; promptGuidelines?: string[]; parameters: unknown };

function measure(active: string[], defs: Map<string, AnyDef>) {
  const tools = active.map((name) => defs.get(name)).filter((d) => d !== undefined);
  let declarations = "";
  for (const def of tools) declarations += JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }) + "\n";
  let snippets = "";
  for (const def of tools) if (def.promptSnippet) snippets += `- ${def.name}: ${def.promptSnippet}\n`;
  const seen = new Set<string>();
  let guidelines = "";
  for (const def of tools) {
    for (const rule of def.promptGuidelines ?? []) {
      const key = rule.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      guidelines += `- ${rule}\n`;
    }
  }
  const total = declarations + snippets + guidelines;
  return {
    tools: tools.map((t) => t.name),
    declarationChars: declarations.length,
    declarationTokens: enc.encode(declarations).length,
    snippetChars: snippets.length,
    snippetTokens: enc.encode(snippets).length,
    guidelineCount: seen.size,
    guidelineChars: guidelines.length,
    guidelineTokens: enc.encode(guidelines).length,
    totalChars: total.length,
    totalTokens: enc.encode(total).length,
  };
}

async function boot(kind: "upstream" | "lean") {
  const harness = new Harness(freshWork);
  if (kind === "upstream") upstream(harness as never);
  else lean(harness as never);
  await harness.emit("session_start", {}, makeCtx(freshWork));
  return measure(harness.getActiveTools(), harness.tools as unknown as Map<string, AnyDef>);
}

const up = await boot("upstream");
const ln = await boot("lean");

const rows: string[][] = [
  ["active tools", up.tools.length + " (" + up.tools.join(", ") + ")", ln.tools.length + " (" + ln.tools.join(", ") + ")"],
  ["declarations (chars)", String(up.declarationChars), String(ln.declarationChars)],
  ["declarations (tokens)", String(up.declarationTokens), String(ln.declarationTokens)],
  ["snippets (chars)", String(up.snippetChars), String(ln.snippetChars)],
  ["snippets (tokens)", String(ln.snippetTokens), String(ln.snippetTokens)],
  ["guidelines", `${up.guidelineCount} rules / ${up.guidelineTokens} tokens`, `${ln.guidelineCount} rules / ${ln.guidelineTokens} tokens`],
  ["TOTAL (chars)", String(up.totalChars), String(ln.totalChars)],
  ["TOTAL (tokens)", String(up.totalTokens), String(ln.totalTokens)],
];
const saved = up.totalTokens - ln.totalTokens;
rows.push(["saved per request", "", `${saved} tokens (${((saved / up.totalTokens) * 100).toFixed(1)}%)`]);

const width = [26, 58, 58];
console.log(`${"upstream " + "pi-hashline-edit-pro@6.3.1"} vs lean (default config, js-tiktoken o200k_base)\n`);
for (const row of rows) {
  console.log(row.map((cell, i) => String(cell).padEnd(width[i])).join("|"));
  if (row[0].startsWith("TOTAL")) console.log("-".repeat(width.reduce((a, b) => a + b + 2, 0)));
}

rmSync(freshHome, { recursive: true, force: true });
rmSync(freshWork, { recursive: true, force: true });
