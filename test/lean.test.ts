/**
 * Tests for pi-hashline-edit-pro-lean:
 *  - every op reaches upstream (integration against the real upstream tools)
 *  - help returns the full upstream description and parameters
 *  - fill-in canonicalization fixes only unambiguous cases
 *  - the tool list cannot change mid-session (gate/config stay frozen)
 *  - config/model gating is enforced per call with upstream's error contract
 */

import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import leanExtension, { __resetLeanStateForTests } from "../src/index.ts";
import { updateConfig } from "pi-hashline-edit-pro/src/config";
import { canonicalizeHashlineArgs, canonicalizeName } from "../src/ops.ts";
import { Harness, makeCtx, validate, ValidationError } from "./harness.ts";

let tmp: string;
let cwd: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lean-test-"));
  process.env.PI_HASHLINE_DIR = path.join(tmp, "hashline-home");
  await fs.mkdir(process.env.PI_HASHLINE_DIR, { recursive: true });
  cwd = path.join(tmp, "work");
  await fs.mkdir(cwd, { recursive: true });
});

afterAll(async () => {
  delete process.env.PI_HASHLINE_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
  const file = path.join(cwd, name);
  await fs.writeFile(file, content, "utf8");
  return file;
}

function anchorRows(text: string): Array<{ anchor: string; content: string }> {
  return text
    .split("\n")
    .filter((l) => /^[a-z]{5}│/.test(l))
    .map((l) => ({ anchor: l.slice(0, 5), content: l.slice(6) }));
}

function textOf(result: any): string {
  if (typeof result.content === "string") return result.content;
  return (result.content ?? [])
    .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
    .join("\n");
}

async function setup(initialActive?: string[]): Promise<Harness> {
  __resetLeanStateForTests();
  const harness = new Harness(cwd, initialActive);
  leanExtension(harness as any);
  await harness.emit("session_start", {}, makeCtx(cwd));
  return harness;
}

// ---------------------------------------------------------------------------

describe("registration and frozen tool list", () => {
  it("registers exactly the lean trio; upstream tools are captured, not registered", async () => {
    const harness = await setup();
    assert.deepEqual([...harness.tools.keys()].sort(), ["hashline", "read", "replace"]);
    for (const name of ["insert", "copy", "move", "replace_match", "grep", "undo_last_change", "outline"]) {
      assert.ok(!harness.tools.has(name), `upstream tool ${name} must not be registered directly`);
    }
    // upstream's commands and handlers still pass through
    assert.ok(harness.commands.includes("hashline-config"));
  });

  it("session_start drops built-in edit and flushes the list exactly once", async () => {
    __resetLeanStateForTests();
    const harness = new Harness(cwd);
    leanExtension(harness as any);
    const withEdit = harness.getActiveTools();
    assert.ok(withEdit.includes("edit"));
    await harness.emit("session_start", {}, makeCtx(cwd));
    const active = harness.getActiveTools();
    assert.ok(!active.includes("edit"), "built-in edit removed");
    for (const name of ["read", "replace", "hashline"]) {
      assert.ok(active.includes(name), `${name} active`);
    }
    assert.equal(harness.setActiveCalls, 1, "exactly one flush at session_start");
  });

  it("model-gate changes never touch the real list (frozen mid-session)", async () => {
    await updateConfig((c: any) => {
      c.disableOnModels = ["gated-*"];
    });
    const harness = await setup();
    const frozen = harness.getActiveTools();

    await harness.emit("model_select", { model: { id: "gated-model" } }, makeCtx(cwd));
    await harness.emit("before_agent_start", {}, makeCtx(cwd, { model: { id: "gated-model" } }));
    assert.deepEqual(harness.getActiveTools(), frozen, "list unchanged under gate");
    assert.equal(harness.setActiveCalls, 1);

    // gate lifted again: upstream restores its shadow, real list stays frozen
    await harness.emit("model_select", { model: { id: "normal-model" } }, makeCtx(cwd));
    assert.deepEqual(harness.getActiveTools(), frozen);
    assert.equal(harness.setActiveCalls, 1);

    await updateConfig((c: any) => {
      c.disableOnModels = [];
    });
  });

  it("gated model: edit ops refuse with E_LEAN_MODEL_GATED, read serves vanilla", async () => {
    await updateConfig((c: any) => {
      c.disableOnModels = ["gated-*"];
    });
    const harness = await setup();
    await harness.emit("model_select", { model: { id: "gated-model" } }, makeCtx(cwd));
    await writeFile("gate.txt", "hello gate\n");

    const gatedCtx = makeCtx(cwd, { model: { id: "gated-model", input: ["text"] } });
    const refused = await harness.callTool(
      "hashline",
      { op: "insert", anchor: "does", direction: "after", text: "x" },
      gatedCtx,
    );
    assert.ok(refused.isError, "insert refuses on gated model");
    assert.match(textOf(refused), /E_LEAN_MODEL_GATED/);

    // readOnDisabledModels defaults to "vanilla": read forwards to the
    // vanilla definition upstream registered under the same name.
    const readResult = await harness.callTool("read", { path: path.join(cwd, "gate.txt") }, gatedCtx);
    const readText = textOf(readResult);
    assert.ok(!readResult.isError, `vanilla read works: ${readText.slice(0, 120)}`);
    assert.ok(!/│/.test(readText), "vanilla read has no anchor separator");
    assert.ok(readText.includes("hello gate"));

    // gated models keep a plain grep under the same name; the op forwards
    const grepGated = await harness.callTool(
      "hashline",
      { op: "grep", pattern: "gate", path: cwd },
      gatedCtx,
    );
    assert.ok(!grepGated.isError, textOf(grepGated).slice(0, 120));
    assert.ok(!/│/.test(textOf(grepGated)), "vanilla grep has no anchor separator");
    // switching back to a non-gated model makes upstream re-register the
    // anchored flavor, and the anchored format returns for it
    await harness.emit("model_select", { model: { id: "normal-model" } }, makeCtx(cwd));
    const anchored = await harness.callTool("read", { path: path.join(cwd, "gate.txt") }, makeCtx(cwd));
    assert.ok(/│/.test(textOf(anchored)), "anchored read for non-gated model");

    await updateConfig((c: any) => {
      c.disableOnModels = [];
    });
  });
});

describe("every op reaches upstream", () => {
  it("read parses anchors; replace rewrites a line", async () => {
    const harness = await setup();
    await writeFile("a.txt", "alpha\nbeta\ngamma\n");

    const read1 = await harness.callTool("read", { path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(read1));
    assert.equal(rows.length, 3);
    assert.equal(rows[0].content, "alpha");

    const replaced = await harness.callTool("replace", {
      remove_from: rows[0].anchor,
      remove_to: rows[0].anchor,
      text: "ALPHA",
    });
    assert.ok(!replaced.isError, textOf(replaced));
    assert.equal(await fs.readFile(path.join(cwd, "a.txt"), "utf8"), "ALPHA\nbeta\ngamma\n");
  });

  it("insert adds a line (also when the anchor is passed as a full anchor│content row)", async () => {
    const harness = await setup();
    await writeFile("a.txt", "alpha\nbeta\n");

    const read1 = await harness.callTool("read", { path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(read1));

    const inserted = await harness.callTool("hashline", {
      op: "insert",
      anchor: `${rows[0].anchor}│alpha`,
      direction: "before",
      text: "HEAD",
    });
    assert.ok(!inserted.isError, textOf(inserted));
    assert.equal(await fs.readFile(path.join(cwd, "a.txt"), "utf8"), "HEAD\nalpha\nbeta\n");
  });

  it("replace_match replaces a substring inside an anchor range", async () => {
    const harness = await setup();
    await writeFile("a.txt", "alpha\nbeta\n");

    const read1 = await harness.callTool("read", { path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(read1));

    const result = await harness.callTool("hashline", {
      op: "replace_match",
      replace_from: rows[0].anchor,
      replace_to: rows[0].anchor,
      match: "alp",
      replacement: "ALP",
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(await fs.readFile(path.join(cwd, "a.txt"), "utf8"), "ALPha\nbeta\n");
  });

  it("replace_match since 6.5.0 rejects old_string/new_string", async () => {
    const harness = await setup();
    await writeFile("a.txt", "alpha\nbeta\n");

    const read1 = await harness.callTool("read", { path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(read1));

    const renamed = await harness.callTool("hashline", {
      op: "replace_match",
      replace_from: rows[0].anchor,
      replace_to: rows[1].anchor,
      old_string: "alp",
      new_string: "ALP",
    });
    assert.ok(renamed.isError);
    assert.match(textOf(renamed), /no longer accepts "old_string"\/"new_string"/);
  });

  it("replace_match since 6.5.0 rejects a multi-line match", async () => {
    const harness = await setup();
    await writeFile("a.txt", "alpha\nbeta\n");

    const read1 = await harness.callTool("read", { path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(read1));

    const multiline = await harness.callTool("hashline", {
      op: "replace_match",
      replace_from: rows[0].anchor,
      replace_to: rows[1].anchor,
      match: "a\nb",
      replacement: "x",
    });
    assert.ok(multiline.isError);
    assert.match(textOf(multiline), /must stay within one line/);
  });

  it("copy duplicates lines into another file, move relocates them, undo reverts", async () => {
    const harness = await setup();
    await writeFile("src.txt", "one\ntwo\nthree\n");
    await writeFile("dst.txt", "x\ny\n");

    const readSrc = await harness.callTool("read", { path: path.join(cwd, "src.txt") });
    const srcRows = anchorRows(textOf(readSrc));
    const readDst = await harness.callTool("read", { path: path.join(cwd, "dst.txt") });
    const dstRows = anchorRows(textOf(readDst));

    // copy src lines 1-2 after dst line 1
    const copied = await harness.callTool("hashline", {
      op: "copy",
      source_from: srcRows[0].anchor,
      source_to: srcRows[1].anchor,
      anchor: dstRows[0].anchor,
      direction: "after",
    });
    assert.ok(!copied.isError, textOf(copied));
    assert.equal(await fs.readFile(path.join(cwd, "dst.txt"), "utf8"), "x\none\ntwo\ny\n");
    assert.equal(await fs.readFile(path.join(cwd, "src.txt"), "utf8"), "one\ntwo\nthree\n");

    // move src line 3 after dst line 1 (anchors for src refreshed by the copy diff;
    // re-read to be explicit)
    const readSrc2 = await harness.callTool("read", { path: path.join(cwd, "src.txt") });
    const srcRows2 = anchorRows(textOf(readSrc2));
    const readDst2 = await harness.callTool("read", { path: path.join(cwd, "dst.txt") });
    const dstRows2 = anchorRows(textOf(readDst2));
    const moved = await harness.callTool("hashline", {
      op: "move",
      source_from: srcRows2[2].anchor,
      source_to: srcRows2[2].anchor,
      anchor: dstRows2[0].anchor,
      direction: "after",
    });
    assert.ok(!moved.isError, textOf(moved));
    assert.equal(await fs.readFile(path.join(cwd, "src.txt"), "utf8"), "one\ntwo\n");
    assert.equal(await fs.readFile(path.join(cwd, "dst.txt"), "utf8"), "x\nthree\none\ntwo\ny\n");

    // undo the move on the destination file
    const undone = await harness.callTool("hashline", {
      op: "undo_last_change",
      path: path.join(cwd, "dst.txt"),
    });
    assert.ok(!undone.isError, textOf(undone));
    assert.equal(await fs.readFile(path.join(cwd, "dst.txt"), "utf8"), "x\none\ntwo\ny\n");
  });

  it("grep searches with anchor rows when enabled", async () => {
    await updateConfig((c: any) => {
      c.anchorGrepEnabled = true;
    });
    const harness = await setup(["bash", "edit", "read", "write", "grep", "find", "ls", "codemode"]);
    // upstream's "grep" registration is captured, never forwarded, and the
    // flushed list drops the name so pi's built-in grep does not compete
    // with the hashline op
    assert.ok(!harness.getActiveTools().includes("grep"));
    await writeFile("g.txt", "keep\nTODO fix\nkeep\n");

    const result = await harness.callTool("hashline", { op: "grep", pattern: "TODO" });
    assert.ok(!result.isError, textOf(result));
    const text = textOf(result);
    assert.ok(text.includes("TODO fix"), text);
    assert.ok(/:│/.test(text), "hits carry the lineNumber:│ anchor row format");

    await updateConfig((c: any) => {
      c.anchorGrepEnabled = false;
    });
  });

  it("op read and op replace forward to the standalone tools", async () => {
    const harness = await setup();
    await writeFile("a.txt", "alpha\n");

    const readViaOp = await harness.callTool("hashline", { op: "read", path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(readViaOp));
    assert.equal(rows.length, 1);

    const replacedViaOp = await harness.callTool("hashline", {
      op: "replace",
      remove_from: rows[0].anchor,
      remove_to: rows[0].anchor,
      text: "beta",
    });
    assert.ok(!replacedViaOp.isError, textOf(replacedViaOp));
    assert.equal(await fs.readFile(path.join(cwd, "a.txt"), "utf8"), "beta\n");
  });

  it("standalone tools keep upstream schemas (minus descriptions) and renderers", async () => {
    const harness = await setup();
    const readDef = harness.tools.get("read");
    assert.equal(readDef.parameters.type, "object");
    assert.ok(readDef.parameters.properties.offset, "offset kept");
    assert.ok(readDef.parameters.properties.offset.anyOf, "offset union kept");
    assert.equal(readDef.parameters.properties.path.description, undefined, "descriptions stripped");
    assert.equal(readDef.parameters.properties.anchors, undefined, "no anchors param outside codemode");
    assert.ok(readDef.outputSchema, "outputSchema kept (free: not sent to the model)");
    assert.ok(typeof readDef.renderCall === "function");
    assert.ok(typeof readDef.renderResult === "function");

    const hashDef = harness.tools.get("hashline");
    assert.ok(hashDef.outputSchema?.anyOf?.length >= 1, "merged outputSchema union");
    // render dispatch does not throw (real pi always provides context.state and theme)
    const stubTheme: any = new Proxy({}, { get: (_t, prop) => (prop === "fg" ? (_name: string, text: string) => text : () => "") });
    const component = hashDef.renderCall({ op: "insert", anchor: "aaaa", text: "x" }, stubTheme, { state: {} });
    assert.ok(component !== undefined);
  });
  it("outline (7.1, opt-in) serves symbol rows for a TS file", async () => {
    await updateConfig((c: any) => {
      c.outlineEnabled = true;
    });
    const harness = await setup();
    const hashDef = harness.tools.get("hashline");
    assert.ok(hashDef.description.includes("- outline:"), "enabled: outline bullet present");
    assert.ok(hashDef.promptSnippet?.includes("outline"), "enabled: snippet lists outline");
    const prefer = (hashDef.promptGuidelines ?? []).find((g: string) =>
      g.includes("Remember to use the hashline tools"),
    );
    assert.ok(prefer !== undefined && prefer.includes("outline"), "prefer rule lists outline");
    assert.equal(hashDef.parameters.properties.depth?.maximum, 10, "depth param with upstream max");

    await writeFile("o.ts", "export function greet() {\n  return 1;\n}\n\nexport const x = 2;\n");
    const result = await harness.callTool("hashline", { op: "outline", path: path.join(cwd, "o.ts") });
    assert.ok(!result.isError, textOf(result).slice(0, 200));
    const text = textOf(result);
    assert.match(text, /o\.ts \(TypeScript\) — \d+ lines ===/);
    assert.ok(text.includes("export function greet"), text);
    assert.match(text, /\[limit \d+\]/, "rows carry their span");
    assert.ok(anchorRows(text).length >= 2, "greet and x rows served");

    await updateConfig((c: any) => {
      c.outlineEnabled = false;
    });
  });
});


describe("help", () => {
  it("returns the full upstream description and parameters for an op", async () => {
    const harness = await setup();
    const result = await harness.callTool("hashline", { op: "help", about: "replace_match" });
    const text = textOf(result);
    assert.ok(!result.isError, text.slice(0, 200));
    assert.match(text, /Replace part of a line/);
    assert.ok(text.includes("replace_from"));
    assert.ok(text.includes("## parameters"));
    assert.ok(text.includes("```json"));
    assert.ok(text.includes("## promptGuidelines"));
  });

  it("canonicalizes about names and rejects unknown ones", async () => {
    const harness = await setup();
    const loose = await harness.callTool("hashline", { op: "help", about: "ReplaceMatch" });
    assert.ok(!loose.isError);
    assert.match(textOf(loose), /Replace part of a line/);

    const unknown = await harness.callTool("hashline", { op: "help", about: "frobnicate" });
    assert.ok(unknown.isError);
    assert.match(textOf(unknown), /E_LEAN_HELP_ABOUT/);
    for (const name of ["read", "replace", "replace_match", "insert", "copy", "move", "grep", "undo_last_change", "outline"]) {
      assert.ok(textOf(unknown).includes(name), `error lists ${name}`);
    }
  });

  it("without about, lists every op with its snippet", async () => {
    const harness = await setup();
    const result = await harness.callTool("hashline", { op: "help" });
    const text = textOf(result);
    assert.ok(!result.isError);
    for (const name of ["replace_match", "insert", "copy", "move", "grep", "undo_last_change", "outline"]) {
      assert.ok(text.includes(name), `lists ${name}`);
    }
  });
});

describe("fill-in canonicalization", () => {
  it("fixes unambiguous op spellings", () => {
    const cases: Array<[string, string, string[]]> = [
      ["ReplaceMatch", "replace_match", ["replace_match"]],
      ["Grep", "grep", ["grep"]],
      ["UNDOLASTCHANGE", "undo_last_change", ["undo_last_change"]],
      ["`insert`", "insert", ["insert"]],
      ["hashline-move", "move", ["move"]],
      ["Insert-Match", "insert", []], // ambiguous? no: see below
    ];
    // last case is intentionally excluded below; run explicit ones here
    const ops = ["replace_match", "insert", "copy", "move", "grep", "undo_last_change", "read", "outline", "replace", "help"];
    assert.equal(canonicalizeName("ReplaceMatch", ops), "replace_match");
    assert.equal(canonicalizeName("Grep", ops), "grep");
    assert.equal(canonicalizeName("anchor_grep", ops), "anchor_grep", "old name is no longer known");
    assert.equal(canonicalizeName("UNDOLASTCHANGE", ops), "undo_last_change");
    assert.equal(canonicalizeName("`insert`", ops), "insert");
    assert.equal(canonicalizeName("hashline-move", ops), "move");
    assert.equal(canonicalizeName(" Replace", ops), "replace");
    void cases;
  });

  it("never guesses when ambiguous or unknown", () => {
    const ops = ["replace_match", "insert", "copy", "move", "grep", "undo_last_change", "read", "outline", "replace", "help"];
    assert.equal(canonicalizeName("re", ops), "re", "too short to disambiguate");
    assert.equal(canonicalizeName("rep", ops), "rep", "matches replace and replace_match");
    assert.equal(canonicalizeName("frobnicate", ops), "frobnicate", "unknown stays unknown");
    assert.equal(canonicalizeName("copy paste", ops), "copy paste", "compound guess stays");
    assert.equal(canonicalizeName(123, ops), 123, "non-strings pass through");
    assert.equal(canonicalizeName("", ops), "", "empty stays");
  });

  it("prepareArguments leaves everything but op untouched (same reference)", () => {
    const args = { op: "move", source_from: "aaaa", source_to: "bbbb", anchor: "cccc", direction: "after" };
    assert.equal(canonicalizeHashlineArgs(args), args, "no copy when nothing changes");
    const fixed = canonicalizeHashlineArgs({ ...args, op: "Move" }) as any;
    assert.equal(fixed.op, "move");
    assert.equal(fixed.source_from, "aaaa");
  });

  it("an unfixable op fails schema validation with the enum error", async () => {
    const harness = await setup();
    assert.throws(
      () => validate({ op: "frobnicate" }, harness.tools.get("hashline").parameters, "hashline"),
      ValidationError,
    );
    assert.throws(
      () => validate({ op: "rep" }, harness.tools.get("hashline").parameters, "hashline"),
      ValidationError,
    );
  });

  it("a fixable op passes validation end-to-end", async () => {
    const harness = await setup();
    await writeFile("a.txt", "alpha\n");
    const read1 = await harness.callTool("read", { path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(read1));
    const result = await harness.callTool("hashline", {
      op: "Insert",
      anchor: rows[0].anchor,
      direction: "after",
      text: "TAIL",
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(await fs.readFile(path.join(cwd, "a.txt"), "utf8"), "alpha\nTAIL\n");
  });
});

describe("config-disabled ops", () => {
  it("refuse per call with E_LEAN_OP_DISABLED while others keep working", async () => {
    await updateConfig((c: any) => {
      c.replaceMatchEnabled = false;
      c.copyMoveEnabled = false;
      c.anchorGrepEnabled = false;
    });
    const harness = await setup();

    const hashDef = harness.tools.get("hashline");
    assert.ok(!hashDef.description.includes("- replace_match:"), "disabled ops drop out of the description");
    assert.ok(!hashDef.description.includes("- copy:"));
    assert.ok(hashDef.description.includes("- insert:"));

    const rm = await harness.callTool("hashline", {
      op: "replace_match",
      replace_from: "aaaa",
      replace_to: "aaaa",
      match: "x",
      replacement: "y",
    });
    assert.ok(rm.isError);
    assert.match(textOf(rm), /E_LEAN_OP_DISABLED/);
    assert.ok(rm.structuredContent?.error?.code, "error carries the structured contract");

    const cp = await harness.callTool("hashline", {
      op: "copy",
      source_from: "aaaa",
      source_to: "bbbb",
      anchor: "cccc",
      direction: "after",
    });
    assert.ok(cp.isError);
    assert.match(textOf(cp), /E_LEAN_OP_DISABLED/);

    // grep never refuses: with anchorGrepEnabled off (or on gated models)
    // upstream swaps in pi's vanilla grep under the same name
    await writeFile("g2.txt", "needle\n");
    const grep = await harness.callTool("hashline", { op: "grep", pattern: "needle", path: cwd });
    assert.ok(!grep.isError, textOf(grep));
    assert.ok(!/│/.test(textOf(grep)), "vanilla grep rows carry no anchors");

    // insert still works
    await writeFile("a.txt", "alpha\n");
    const read1 = await harness.callTool("read", { path: path.join(cwd, "a.txt") });
    const rows = anchorRows(textOf(read1));
    const ok = await harness.callTool("hashline", {
      op: "insert",
      anchor: rows[0].anchor,
      direction: "after",
      text: "ok",
    });
    assert.ok(!ok.isError, textOf(ok));

    await updateConfig((c: any) => {
      c.replaceMatchEnabled = true;
      c.copyMoveEnabled = true;
      c.anchorGrepEnabled = true;
    });
  });
  it("outline (7.1) refuses with E_LEAN_OP_DISABLED until enabled", async () => {
    const harness = await setup(["bash", "read", "replace", "hashline", "outline"]);
    assert.ok(!harness.getActiveTools().includes("outline"), "flush drops outline from the active list");
    const hashDef = harness.tools.get("hashline");
    assert.ok(!hashDef.description.includes("- outline:"), "no outline bullet while off");
    assert.ok(!hashDef.promptSnippet?.includes("outline"), "no outline in the snippet while off");

    await writeFile("o.ts", "export const one = 1;\n");
    const refused = await harness.callTool("hashline", { op: "outline", path: path.join(cwd, "o.ts") });
    assert.ok(refused.isError);
    assert.match(textOf(refused), /E_LEAN_OP_DISABLED/);
    assert.match(textOf(refused), /\/hashline-config/);
  });
});

describe("flag-aware prompt text", () => {
  it("requirePath mode: guideline + required path in the replace schema", async () => {
    await updateConfig((c: any) => {
      c.requirePath = true;
    });
    const harness = await setup();
    const replaceDef = harness.tools.get("replace");
    assert.ok(
      (replaceDef.promptGuidelines ?? []).some((g: string) => g.includes("pass `path` matching")),
      "requirePath guideline present",
    );
    assert.ok(replaceDef.parameters.required?.includes("path"), "path becomes required");

    await updateConfig((c: any) => {
      c.requirePath = false;
    });
  });

  it("default mode makes `path` optional but ownership-checked", async () => {
    const harness = await setup();
    const replaceDef = harness.tools.get("replace");
    assert.ok(
      (replaceDef.promptGuidelines ?? []).some((g: string) => g.includes("`path` is optional but must match anchor ownership")),
    );
    assert.ok(!replaceDef.parameters.required?.includes("path"));
  });

  it("strictInput mode adds the strict guideline", async () => {
    await updateConfig((c: any) => {
      c.strictInput = true;
    });
    const harness = await setup();
    assert.ok(
      (harness.tools.get("hashline").promptGuidelines ?? []).some((g: string) =>
        g.includes("Strict-input mode is on"),
      ),
    );
    const strictRule = (harness.tools.get("hashline").promptGuidelines ?? []).find((g: string) =>
      g.includes("Strict-input mode is on"),
    );
    assert.ok(
      strictRule !== undefined && !strictRule.includes("replace_match"),
      "since upstream 6.5.0 strict-input no longer rejects replace_match retype/whole-range inputs",
    );

    await updateConfig((c: any) => {
      c.strictInput = false;
    });
  });

  it("codemode in the active loadout switches to the codemode contract", async () => {
    const harness = await setup([
      "bash",
      "edit",
      "read",
      "write",
      "grep",
      "find",
      "ls",
      "codemode",
    ]);
    assert.ok(
      (harness.tools.get("hashline").promptGuidelines ?? []).some((g: string) =>
        g.includes("branch on `ok`"),
      ),
      "codemode failure contract present",
    );
    assert.ok(
      (harness.tools.get("replace").promptGuidelines ?? []).some((g: string) =>
        g.includes("branch on `ok`"),
      ),
      "standalone replace gets it too",
    );
    // 6.4.8: codemode read resolves to plain text; `anchors: true` opts back
    // into the structured result, and the captured read schema gains the param
    assert.ok(
      (harness.tools.get("read").promptGuidelines ?? []).some((g: string) =>
        g.includes("pass `anchors: true`"),
      ),
      "codemode read-results rule present",
    );
    assert.equal(harness.tools.get("read").parameters.properties.anchors?.type, "boolean");
    assert.ok(!harness.tools.get("read").parameters.properties.anchors?.description);
  });

  it("codemode + outlineEnabled adds the outline results rule (7.1)", async () => {
    await updateConfig((c: any) => {
      c.outlineEnabled = true;
    });
    const loadout = ["bash", "edit", "read", "write", "grep", "find", "ls", "codemode"];
    const harness = await setup(loadout);
    assert.ok(
      (harness.tools.get("hashline").promptGuidelines ?? []).some((g: string) =>
        g.includes("`outline` from a codemode script"),
      ),
      "codemode outline rule present",
    );

    await updateConfig((c: any) => {
      c.outlineEnabled = false;
    });
    const harness2 = await setup(loadout);
    assert.ok(
      !(harness2.tools.get("hashline").promptGuidelines ?? []).some((g: string) =>
        g.includes("`outline` from a codemode script"),
      ),
      "rule gone while outline is off",
    );
  });
  it("read description mentions the vanilla fallback for gated models", async () => {
    const harness = await setup();
    assert.ok(harness.tools.get("read").description.includes("without anchors"));
  });
  it("upstream 7.0 text contracts: anchor-limit wording, replace_match match/replacement rule", async () => {
    const harness = await setup();
    const readDesc = harness.tools.get("read").description;
    assert.ok(
      readDesc.includes("`limit` counts the lines returned starting at that anchor row"),
      "anchor offset limit counts from the anchor row (inclusive)",
    );
    const hashDesc = harness.tools.get("hashline").description;
    assert.ok(
      hashDesc.includes("only the fragment that changes"),
      "replace_match bullet carries the fragment-only contract",
    );
    assert.ok(
      hashDesc.includes("`match` stays within one line") &&
        hashDesc.includes("`replacement` may span lines"),
      "replace_match bullet carries the 7.0.0 multi-line replacement rule",
    );
    assert.ok(
      hashDesc.includes("use `replace` with the same anchor"),
      "whole-line/whole-range changes are routed to replace",
    );
    assert.ok(
      (harness.tools.get("hashline").promptGuidelines ?? []).some((g: string) =>
        g.includes("Remember to use the hashline tools"),
      ),
      "preference rule mirrors upstream's 'Remember to use' wording",
    );
  });
});
