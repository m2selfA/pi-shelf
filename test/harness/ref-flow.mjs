#!/usr/bin/env node
/**
 * Exercises /shelf ref add/list/resolve against a temporary agent directory.
 *
 *   node --experimental-strip-types test/harness/ref-flow.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = await mkdtemp(join(tmpdir(), "pi-shelf-ref-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "pi-shelf"), { recursive: true });

const mod = await import("../../index.ts");
const commands = [];
mod.default({ on: () => {}, registerCommand: (name, def) => commands.push([name, def]), registerShortcut: () => {}, registerTool: () => {}, getAllTools: () => [], getActiveTools: () => [] });
const shelf = commands[0][1];
const inserted = [];
const notes = [];
const ui = {
  notify: (message) => notes.push(message),
  confirm: async () => true,
  input: async () => undefined,
  select: async (_title, options) => options[0],
  editor: async (_title, prefill) => prefill ?? "",
  pasteToEditor: (text) => inserted.push(text),
  setEditorText: (text) => inserted.push(text),
  getEditorText: () => "",
};
const ctx = { ui, mode: "rpc", cwd: process.cwd(), sessionManager: { getEntries: () => [] }, isProjectTrusted: () => true };

await shelf.handler("ref add https://github.com/cryoem/eman2", ctx);
await shelf.handler("ref add 3dem/relion", ctx);
await shelf.handler("ref add earendil-works/pi", ctx);
await shelf.handler("ref add https://github.com/3dem/relion --alias rel --aliases rel5", ctx);

notes.length = 0;
await shelf.handler("ref list", ctx);
assert.match(notes.at(-1), /cryoem\/eman2.*https:\/\/github\.com\/cryoem\/eman2/);
assert.match(notes.at(-1), /3dem\/relion/);

await shelf.handler("ref cryo", ctx);
assert.equal(inserted.at(-1), "https://github.com/cryoem/eman2");

await shelf.handler("ref rel", ctx);
assert.equal(inserted.at(-1), "https://github.com/3dem/relion");

await shelf.handler("ref eman", ctx);
assert.equal(inserted.at(-1), "https://github.com/cryoem/eman2");

console.log("ref flow harness: OK");
