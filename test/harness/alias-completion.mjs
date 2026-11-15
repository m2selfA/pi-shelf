#!/usr/bin/env node
/**
 * Drives custom abbreviation expansion through the real provider.
 *
 *   node --experimental-strip-types test/harness/alias-completion.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

const agentDir = await mkdtemp(join(tmpdir(), "pi-shelf-alias-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const dir = join(agentDir, "pi-shelf");
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "config.json"), JSON.stringify({
  version: 1,
  topics: [], sources: [], values: [],
  aliases: [
    { key: "ws", value: "web_search" },
    { key: "wf", value: "web_fetch" },
    { key: "xb", value: "D:/opt/scoop/buckets/xhark/bucket" },
    { key: "dt", value: "today={{date}}" },
    { key: "cur", value: "hello {{cursor}}world" },
  ],
}, null, 2));

const handlers = new Map();
const fakePi = {
  on: (name, fn) => { handlers.set(name, fn); },
  registerCommand: () => {}, registerShortcut: () => {}, registerTool: () => {},
  getAllTools: () => [{ name: "web_search", description: "Search", exposure: "direct", sourceInfo: { source: "builtin" } }],
  getActiveTools: () => ["web_search"],
};
let provider = null;
const ui = {
  addAutocompleteProvider: (factory) => {
    provider = factory({ getSuggestions: async () => ({ items: [], prefix: "" }), applyCompletion: (l, cl, cc) => ({ lines: l, cursorLine: cl, cursorCol: cc }), shouldTriggerFileCompletion: () => true });
  },
  onTerminalInput: () => {}, notify: () => {},
};
initTheme("dark", false);
const mod = await import("../../index.ts");
mod.default(fakePi);
await handlers.get("session_start")({}, { ui, cwd: process.cwd(), isProjectTrusted: () => true });

const options = { signal: AbortSignal.timeout(5000) };
const suggest = async (line, force) => {
  const result = await provider.getSuggestions([line], 0, line.length, { ...options, force });
  return result ? result.items : [];
};

assert.equal((await suggest("use ws", false)).length, 0, "an abbreviation does not auto-open");
const ws = await suggest("use ws", true);
assert.equal(ws[0].label.startsWith("ws → web_search"), true);
assert.equal(ws[0].value, "web_search");
const applied = provider.applyCompletion(["use ws"], 0, 6, ws[0], "ws");
assert.deepEqual(applied, { lines: ["use web_search "], cursorLine: 0, cursorCol: 15 });

const xb = await suggest("use xb", true);
assert.equal(xb[0].value, "D:/opt/scoop/buckets/xhark/bucket");

const dt = await suggest("use dt", true);
assert.match(dt[0].value, /^today=\d{4}-\d{2}-\d{2}$/);

const cur = await suggest("use cur", true);
const cursorApplied = provider.applyCompletion(["use cur"], 0, 7, cur[0], "cur");
assert.deepEqual(cursorApplied, { lines: ["use hello world "], cursorLine: 0, cursorCol: 10 });
console.log("alias completion harness: OK");
