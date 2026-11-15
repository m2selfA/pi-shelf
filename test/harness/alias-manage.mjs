#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = await mkdtemp(join(tmpdir(), "pi-shelf-alias-manage-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "pi-shelf"), { recursive: true });

const mod = await import("../../index.ts");
const commands = [];
mod.default({ on: () => {}, registerCommand: (name, def) => commands.push([name, def]), registerShortcut: () => {}, registerTool: () => {}, getAllTools: () => [], getActiveTools: () => [] });
const shelf = commands[0][1];

const answers = [];
const notes = [];
const ui = {
  notify: (message) => notes.push(message),
  confirm: async () => true,
  input: async () => answers.shift(),
  select: async (_title, options) => answers.shift() ?? options[0],
  editor: async (_title, prefill) => answers.shift() ?? prefill ?? "",
  pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "",
};
const ctx = { ui, mode: "rpc", cwd: process.cwd(), sessionManager: { getEntries: () => [] }, isProjectTrusted: () => true };

answers.push("新增", "ws", "手动输入（支持宏）", "web_search");
await shelf.handler("alias", ctx);
let config = JSON.parse(await readFile(join(agentDir, "pi-shelf", "config.json"), "utf8"));
assert.deepEqual(config.aliases, [{ key: "ws", value: "web_search" }]);

answers.push("列出");
await shelf.handler("alias", ctx);
assert.match(notes.at(-1), /ws → web_search/);

answers.push("更改", "ws → web_search", "ws", "手动输入（支持宏）", "web_fetch");
await shelf.handler("alias", ctx);
config = JSON.parse(await readFile(join(agentDir, "pi-shelf", "config.json"), "utf8"));
assert.equal(config.aliases[0].value, "web_fetch");

answers.push("删除", "ws → web_fetch", "删除");
await shelf.handler("alias", ctx);
config = JSON.parse(await readFile(join(agentDir, "pi-shelf", "config.json"), "utf8"));
assert.deepEqual(config.aliases, []);
console.log("alias manage harness: OK");
