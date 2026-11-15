import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "../src/match.ts";
import { archiveItem, emptyCollection, mergeCollection, mergeItems, mergeProject, mergeRules, normalizeRemote, projectFileUsable, restoreItem, shellPlan, splitLegacy, trustState } from "../src/store.ts";

function item(id: string, value: string): Item {
  return { id, category: "GitHub", title: id, value, tags: [], source: "manual", uses: 0, created: "", updated: "" };
}

test("a save unions what another window added instead of dropping it", () => {
  const disk = { ...emptyCollection(), items: [item("a", "https://github.com/a/b"), item("disk-only", "https://example.com/d")] };
  const memory = { ...emptyCollection(), items: [item("a", "https://github.com/a/b"), item("memory-only", "https://example.com/m")] };
  const merged = mergeCollection(disk, memory);
  assert.deepEqual(merged.items.map((entry) => entry.id).sort(), ["a", "disk-only", "memory-only"]);
});

test("an item archived in memory is not resurrected from disk", () => {
  const disk = { ...emptyCollection(), items: [item("gone", "https://example.com/g")] };
  const memory = { ...emptyCollection(), archive: [{ ...item("gone", "https://example.com/g"), updated: "2026-01-01" }] };
  const merged = mergeCollection(disk, memory);
  assert.equal(merged.items.length, 0);
  assert.equal(merged.archive.length, 1);
});

test("the newer copy of an edited item wins", () => {
  const older = { ...item("a", "https://example.com"), updated: "2026-01-01" };
  const newer = { ...item("a", "https://example.com"), title: "renamed", updated: "2026-02-01" };
  assert.equal(mergeCollection({ ...emptyCollection(), items: [older] }, { ...emptyCollection(), items: [newer] }).items[0]?.title, "renamed");
  assert.equal(mergeCollection({ ...emptyCollection(), items: [newer] }, { ...emptyCollection(), items: [older] }).items[0]?.title, "renamed");
});

test("an item with no timestamp still updates over the disk copy", () => {
  const disk = { ...item("a", "https://example.com"), updated: "" };
  const memory = { ...item("a", "https://example.com"), title: "renamed", updated: "2026-03-01T00:00:00Z" };
  assert.equal(mergeCollection({ ...emptyCollection(), items: [disk] }, { ...emptyCollection(), items: [memory] }).items[0]?.title, "renamed");
});

test("project merge unions items but keeps the memory rules", () => {
  const disk = { version: 1 as const, remote: "r", items: [item("d", "https://example.com/d")], archive: [], topics: [], sources: [], values: [] };
  const memory = { version: 1 as const, remote: "r", items: [item("m", "https://example.com/m")], archive: [], topics: [{ id: "t", category: "C", tags: [], pattern: "x" }], sources: [], values: [{ id: "v", command: "echo" }] };
  const merged = mergeProject(disk, memory);
  assert.deepEqual(merged.items.map((entry) => entry.id).sort(), ["d", "m"]);
  assert.equal(merged.topics.length, 1);
  assert.equal(merged.values[0]?.id, "v");
});

test("trust is trust-on-first-use and then hash-pinned", () => {
  assert.equal(trustState(undefined, "abc"), "first-seen");
  assert.equal(trustState("abc", "abc"), "approved");
  assert.equal(trustState("abc", "def"), "changed");
});

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
    { version: 1, topics: [{ id: "empiar", category: "Data", tags: [], pattern: "old" }], sources: [], values: [] },
    { version: 1, topics: [{ id: "empiar", category: "Data", tags: ["lab"], pattern: "new" }], sources: [{ id: "src", category: "Path", tags: [], command: "pwd" }], values: [{ id: "branch", command: "git branch" }] },
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

test("bash sources restore the caller cwd because a login shell resets it", () => {
  const plan = shellPlan("linux", "bash: pwd", "E:/tmp/probe");
  assert.equal(plan[0]?.command, "bash");
  assert.equal(plan[0]?.args[0], "-lc");
  assert.equal(plan[0]?.args[1], "cd -- 'E:/tmp/probe' && pwd");
  // Without a cwd the command is passed through untouched.
  assert.equal(shellPlan("linux", "bash: pwd")[0]?.args[1], "pwd");
});
