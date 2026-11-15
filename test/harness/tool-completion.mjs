#!/usr/bin/env node
/**
 * Drives the real autocomplete provider with a fake tool registry.
 *
 *   node --experimental-strip-types test/harness/tool-completion.mjs
 */
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";

const handlers = new Map();
const tools = [
  { name: "web_search", description: "Search the web", exposure: "direct", sourceInfo: { source: "builtin", path: "builtin:web_search" } },
  { name: "web_fetch", description: "Fetch a URL", exposure: "direct", sourceInfo: { source: "builtin", path: "builtin:web_fetch" } },
  { name: "read", description: "Read files", exposure: "direct", sourceInfo: { source: "builtin", path: "builtin:read" } },
  { name: "mcp__github__search_code", description: "Search code", exposure: "direct", namespace: { name: "mcp__github" }, sourceInfo: { source: "builtin", path: "builtin:mcp" } },
];
const fakePi = {
  on: (name, fn) => { handlers.set(name, fn); },
  registerCommand: () => {},
  registerShortcut: () => {},
  registerTool: () => {},
  getAllTools: () => tools,
  getActiveTools: () => ["read", "web_search"],
};

let provider = null;
const ui = {
  addAutocompleteProvider: (factory) => {
    provider = factory({
      getSuggestions: async () => ({ items: [], prefix: "" }),
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
      shouldTriggerFileCompletion: () => true,
    });
  },
  onTerminalInput: () => {},
  notify: () => {},
};

initTheme("dark", false);
const mod = await import("../../index.ts");
mod.default(fakePi);
await handlers.get("session_start")({}, { ui, cwd: process.cwd(), isProjectTrusted: () => true });

const options = { signal: AbortSignal.timeout(5000) };
const suggest = async (line, force) => {
  const result = await provider.getSuggestions([line], 0, line.length, { ...options, force });
  return result ? result.items.map((item) => item.label) : [];
};

assert.deepEqual(await suggest("please use web_", false), ["web_search", "web_fetch"], "underscore opens without Tab");
assert.deepEqual((await suggest("please use web", false)), [], "a bare word waits for Tab");
assert.deepEqual(await suggest("please use web", true), ["web_search", "web_fetch"], "Tab completes a bare word");
assert.deepEqual(await suggest("call mcp__github__se", false), ["mcp__github__search_code"], "MCP names complete");
assert.deepEqual(await suggest("please use zzz", true), [], "unknown tokens stay quiet");

const picked = await provider.getSuggestions(["use web_"], 0, 8, { ...options, force: false });
const applied = provider.applyCompletion(["use web_"], 0, 8, picked.items[0], picked.prefix);
assert.deepEqual(applied, { lines: ["use web_search "], cursorLine: 0, cursorCol: 15 }, "the token is replaced and a space follows");
console.log("tool completion harness: OK");
