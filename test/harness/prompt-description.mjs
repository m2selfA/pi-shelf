#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = await mkdtemp(join(tmpdir(), "pi-shelf-prompt-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "prompts"), { recursive: true });
await writeFile(join(agentDir, "prompts", "demo.md"), "---\ndescription: Review staged changes\nargument-hint: '[focus]'\n---\nReview ${1:-this change}.\n");

const mod = await import("../../index.ts");
const commands = [];
mod.default({ on: () => {}, registerCommand: (name, def) => commands.push([name, def]), registerShortcut: () => {}, registerTool: () => {}, getAllTools: () => [], getActiveTools: () => [] });
const shelf = commands[0][1];
let options = [];
const ui = {
  notify: () => {}, confirm: async () => true, input: async () => "demo", select: async (_t, values) => { options = values; return values[0]; }, editor: async (_t, p) => p ?? "", pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "",
};
await shelf.handler("", { ui, mode: "rpc", cwd: process.cwd(), sessionManager: { getEntries: () => [] }, isProjectTrusted: () => true });
assert.ok(options.some((option) => option.includes("Review staged changes")), "prompt description appears in the selector");
console.log("prompt description harness: OK");
