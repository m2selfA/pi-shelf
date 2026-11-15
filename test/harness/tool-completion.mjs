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
  { name: "ssh_upload", description: "Upload a file over ssh", exposure: "direct", sourceInfo: { source: "npm:@hackxit/pi-ssh-tools", path: "/x/pi-ssh-tools/index.ts" } },
  { name: "ssh_bash", description: "Run a remote command", exposure: "direct", sourceInfo: { source: "npm:@hackxit/pi-ssh-tools", path: "/x/pi-ssh-tools/index.ts" } },
  { name: "runs_submit", description: "Submit a run", exposure: "direct", sourceInfo: { source: "E:/repos/pi-runs", path: "E:/repos/pi-runs/extensions/runs/index.ts" } },
  { name: "x_search", description: "Search X", exposure: "direct", sourceInfo: { source: "auto", path: "C:/agent/extensions/search-boost.js" } },
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
assert.deepEqual(await suggest("use web-", false), [], "hyphen alone never auto-opens");
assert.deepEqual(await suggest("use web-", true), ["web_search", "web_fetch"], "hyphen matches underscore after Tab");
assert.deepEqual(await suggest("use ssh_", false), ["ssh_bash", "ssh_upload"], "plugin tools complete by tool name");
assert.deepEqual(await suggest("use pi-ssh", false), [], "a hyphenated plugin name does not auto-open");
assert.deepEqual(await suggest("use pi-ssh", true), ["pi-ssh-tools", "ssh_bash", "ssh_upload"], "a plugin name opens on Tab, with its tools");
assert.deepEqual(await suggest("use pi-ssh-tools", true), ["pi-ssh-tools", "ssh_bash", "ssh_upload"], "the full plugin name works too");
assert.deepEqual(await suggest("use search-boost", true), ["search-boost", "x_search"], "a hyphenated plugin name works through Tab");

const picked = await provider.getSuggestions(["use web_"], 0, 8, { ...options, force: false });
const applied = provider.applyCompletion(["use web_"], 0, 8, picked.items[0], picked.prefix);
assert.deepEqual(applied, { lines: ["use web_search "], cursorLine: 0, cursorCol: 15 }, "the token is replaced and a space follows");

const packageHit = await provider.getSuggestions(["use pi-ssh"], 0, 10, { ...options, force: true });
assert.equal(packageHit.items[0].label, "pi-ssh-tools");
const packageApplied = provider.applyCompletion(["use pi-ssh"], 0, 10, packageHit.items[0], packageHit.prefix);
assert.deepEqual(packageApplied, { lines: ["use pi-ssh-tools "], cursorLine: 0, cursorCol: 17 }, "a package name is inserted literally");
console.log("tool completion harness: OK");
