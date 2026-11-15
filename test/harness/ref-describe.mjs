#!/usr/bin/env node
/**
 * Verifies that the shelf tool's ref_describe path prefers GitHub MCP over the API.
 *
 *   node --experimental-strip-types test/harness/ref-describe.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = await mkdtemp(join(tmpdir(), "pi-shelf-desc-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "pi-shelf"), { recursive: true });

const tools = [];
const commands = [];
const mod = await import("../../index.ts");
mod.default({
  on: () => {},
  registerCommand: (name, def) => commands.push([name, def]),
  registerShortcut: () => {},
  registerTool: (def) => tools.push(def),
  getAllTools: () => [{ name: "mcp__github__search_repositories", description: "Search repositories", exposure: "direct", sourceInfo: { source: "builtin" } }],
  getActiveTools: () => ["mcp__github__search_repositories"],
});
const shelf = commands[0][1];
const tool = tools[0];
const notes = [];
const ui = { notify: (message) => notes.push(message), confirm: async () => true, input: async () => undefined, select: async (_t, options) => options[0], editor: async (_t, p) => p ?? "", pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "" };
const commandCtx = { ui, mode: "rpc", cwd: process.cwd(), sessionManager: { getEntries: () => [] }, isProjectTrusted: () => true };

await shelf.handler("ref add https://github.com/cryoem/eman2 --description placeholder", commandCtx);

const calls = [];
const toolCtx = {
  ui,
  cwd: process.cwd(),
  executeTool: async (name, args) => {
    calls.push([name, args]);
    return { isError: false, content: [{ type: "text", text: JSON.stringify({ description: "MCP says: cryo-EM image processing suite" }) }] };
  },
};
const result = await tool.execute("call-1", { action: "ref_describe", query: "eman" }, undefined, undefined, toolCtx);
assert.match(result.content[0].text, /MCP says/);
assert.equal(calls[0][0], "mcp__github__search_repositories");

const store = JSON.parse(await readFile(join(agentDir, "pi-shelf", "store.json"), "utf8"));
assert.equal(store.items[0].description, "MCP says: cryo-EM image processing suite");
console.log("ref describe harness: OK");
