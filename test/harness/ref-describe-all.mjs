#!/usr/bin/env node
/**
 * Exercises /shelf ref describe-all and --missing against a local page.
 *
 *   node --experimental-strip-types test/harness/ref-describe-all.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><head><title>Local Repo Description</title></head></html>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const agentDir = await mkdtemp(join(tmpdir(), "pi-shelf-desc-all-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "pi-shelf"), { recursive: true });

const mod = await import("../../index.ts");
const commands = [];
mod.default({ on: () => {}, registerCommand: (name, def) => commands.push([name, def]), registerShortcut: () => {}, registerTool: () => {}, getAllTools: () => [], getActiveTools: () => [] });
const shelf = commands[0][1];
const notes = [];
const ui = { notify: (message) => notes.push(message), confirm: async () => true, input: async () => undefined, select: async (_t, options) => options[0], editor: async (_t, p) => p ?? "", pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "" };
const ctx = { ui, mode: "rpc", cwd: process.cwd(), sessionManager: { getEntries: () => [] }, isProjectTrusted: () => true };

const url = `http://127.0.0.1:${port}/page`;
await shelf.handler(`ref add ${url} --description old`, ctx);
notes.length = 0;
await shelf.handler("ref describe-all", ctx);
const storePath = join(agentDir, "pi-shelf", "store.json");
let store = JSON.parse(await readFile(storePath, "utf8"));
assert.equal(store.items[0].description, "Local Repo Description");
assert.match(notes.at(-1), /更新 1 条/);

await shelf.handler(`ref add ${url}?other=1 --description keep-me`, ctx);
notes.length = 0;
await shelf.handler("ref describe-all --missing", ctx);
store = JSON.parse(await readFile(storePath, "utf8"));
const kept = store.items.find((item) => item.value.includes("other=1"));
assert.equal(kept.description, "keep-me", "--missing must not overwrite an existing description");
console.log("ref describe-all harness: OK");
server.close();
