#!/usr/bin/env node
/**
 * Read-only shelf access for scripts and other agents. Writes stay in the Pi extension,
 * where the confirmation dialogs and the lock live.
 *
 *   pi-shelf list [--json]
 *   pi-shelf search <query> [--json]
 *   pi-shelf get <id|value> [--json]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseQuery, rankRows, type Row } from "./src/match.ts";
import { splitLegacy } from "./src/store.ts";

function shelfDir() {
  const agent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agent, "pi-shelf");
}

async function loadItems(): Promise<Row[]> {
  try {
    const raw = JSON.parse(await readFile(join(shelfDir(), "store.json"), "utf8"));
    return splitLegacy(raw).collection.items;
  } catch {
    return [];
  }
}

function oneLine(text: string, max = 100) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function printRows(rows: Row[], json: boolean) {
  if (json) {
    process.stdout.write(JSON.stringify(rows.map(({ id, category, title, value, tags, uses, updated }) => ({ id, category, title, value, tags, uses, updated })), null, 2) + "\n");
    return;
  }
  for (const row of rows) {
    process.stdout.write(`@${row.category}  ${oneLine(row.title, 60)}  →  ${oneLine(row.value)}\n`);
  }
  if (!rows.length) process.stdout.write("（空）\n");
}

async function main(argv: string[]) {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const [command, ...rest] = args;
  const items = await loadItems();
  if (command === "list" || command === undefined) return printRows(items, json);
  if (command === "search") {
    const query = rest.join(" ").trim();
    if (!query) {
      process.stderr.write("用法：pi-shelf search <query>\n");
      process.exitCode = 2;
      return;
    }
    return printRows(rankRows(items, query, 20).map((hit) => hit.row), json);
  }
  if (command === "get") {
    const key = rest.join(" ").trim();
    const found = items.filter((item) => item.id === key || item.value === key || item.title.toLowerCase() === key.toLowerCase());
    if (!found.length) {
      process.stderr.write(`没有匹配：${key}\n`);
      process.exitCode = 1;
      return;
    }
    return printRows(found, json);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write("pi-shelf list | search <query> | get <id|value>  [--json]\n");
    return;
  }
  process.stderr.write(`未知命令：${command}\n`);
  process.exitCode = 2;
}

await main(process.argv.slice(2));
