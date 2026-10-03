import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "../src/match.ts";
import { archiveItem, emptyCollection, mergeItems, mergeRules, normalizeRemote, projectFileUsable, restoreItem, shellPlan, splitLegacy } from "../src/store.ts";

function item(id: string, value: string): Item {
  return { id, category: "GitHub", title: id, value, tags: [], source: "manual", uses: 0, created: "", updated: "" };
}

test("git remotes normalize to the same identity", () => {
  assert.equal(normalizeRemote("git@github.com:3dem/relion.git"), "github.com/3dem/relion");
  assert.equal(normalizeRemote("https://github.com/3dem/relion.git"), "github.com/3dem/relion");
  assert.equal(normalizeRemote("ssh://git@github.com/3dem/relion"), "github.com/3dem/relion");
});

test("a shelf file from another remote is not this project", () => {
  assert.equal(projectFileUsable("github.com/3dem/relion", "github.com/other/repo"), false);
  assert.equal(projectFileUsable("", "github.com/3dem/relion"), true);
  assert.equal(projectFileUsable("git@github.com:3dem/relion.git", "https://github.com/3dem/relion"), true);
});

test("legacy store splits rules out of the collection", () => {
  const split = splitLegacy({ version: 1, items: [item("a", "https://github.com/3dem/relion")], topics: [{ id: "empiar", category: "Data", tags: [], pattern: "EMPIAR-\\d+" }], sources: [{ id: "src", category: "GitHub", tags: [], command: "true" }] });
  assert.equal(split.strip, true);
  assert.equal(split.collection.items.length, 1);
  assert.equal(split.rules.topics[0]?.id, "empiar");
  assert.equal(split.collection.archive.length, 0);
  assert.equal(splitLegacy(emptyCollection()).strip, false);
});

test("project value hides the global one and delete can be restored", () => {
  const merged = mergeItems([item("g", "https://github.com/3dem/relion"), item("keep", "https://github.com/earendil-works/pi")], [item("p", "https://github.com/3dem/relion")]);
  assert.deepEqual(merged.map((entry) => [entry.id, entry.scope]), [["p", "project"], ["keep", "global"]]);
  const rules = mergeRules(
    { version: 1, topics: [{ id: "empiar", category: "Data", tags: [], pattern: "old" }], sources: [] },
    { version: 1, topics: [{ id: "empiar", category: "Data", tags: ["lab"], pattern: "new" }], sources: [{ id: "src", category: "Path", tags: [], command: "pwd" }] },
  );
  assert.equal(rules.topics.length, 1);
  assert.equal(rules.topics[0]?.pattern, "new");
  const bag = { items: [item("g", "https://github.com/3dem/relion")], archive: [] as Item[] };
  archiveItem(bag, "g", "now");
  assert.equal(bag.items.length, 0);
  restoreItem(bag, "g", "later");
  assert.equal(bag.items[0]?.value, "https://github.com/3dem/relion");
  assert.equal(bag.archive.length, 0);
});

test("windows dynamic sources try powershell before cmd", () => {
  const plan = shellPlan("win32", "Get-ChildItem");
  assert.deepEqual(plan.map((call) => call.command), ["powershell.exe", "cmd.exe"]);
  assert.equal(shellPlan("win32", "cmd: dir")[0]?.command, "cmd.exe");
  assert.equal(shellPlan("linux", "git remote -v")[0]?.command, "bash");
});
