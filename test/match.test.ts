import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth as displayWidth } from "@earendil-works/pi-tui";
import { addDirArgument, choices, draftSeed, frecency, githubHits, harvestHits, isMachinePath, isPathLikeToken, isPromptRow, label, parseQuery, pathToken, rankPath, rankRows, score, shelfCompletionContext, shelfInterceptionContext, shelfMatches, shelfQueryContext, slashCommandContext, slashCommandToken, type Item, type Row } from "../src/match.ts";

const relion: Row = {
  id: "1",
  category: "GitHub",
  title: "3dem/relion",
  value: "https://github.com/3dem/relion",
  tags: ["github", "cryo-em"],
  source: "manual",
  uses: 2,
  created: "",
  updated: "",
};

const paper: Row = {
  ...relion,
  id: "2",
  category: "Paper",
  title: "AreTomo3",
  value: "https://doi.org/10.1038/s41592-024-02477-2",
  tags: ["cryo-et"],
};

test("multi-tag filter is AND and category is fuzzy", () => {
  const query = parseQuery("@git #cryo-em relion");
  assert.equal(query.category, "git");
  assert.deepEqual(query.tags, ["cryo-em"]);
  assert.equal(score(relion, query) < Infinity, true);
  assert.equal(score(paper, query), Infinity);
  assert.equal(score(relion, parseQuery("#cryo-em #missing")), Infinity);
});

test("a title hit outranks a value hit and an exact title ranks first", () => {
  const row = (id: string, title: string, value: string, tags: string[] = []): Row => ({ ...relion, id, title, value, tags, category: "Note" });
  const rows = [
    row("value", "notes", "https://github.com/3dem/relion"),
    row("prefix", "relion-blurry-notes", "https://example.com"),
    row("exact", "relion", "https://github.com/3dem/relion"),
  ];
  assert.deepEqual(rankRows(rows, "relion").map((hit) => hit.row.id), ["exact", "prefix", "value"]);
});

test("recent use outranks an old but larger count", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const old = { ...relion, id: "old", uses: 10, lastUsed: "2025-01-01T00:00:00Z" };
  const recent = { ...relion, id: "new", uses: 2, lastUsed: "2026-05-30T00:00:00Z" };
  assert.deepEqual(rankRows([old, recent], "relion", 10, now).map((hit) => hit.row.id), ["new", "old"]);
  assert.ok(frecency(2, "2026-05-30T00:00:00Z", now) > frecency(10, "2025-01-01T00:00:00Z", now));
  assert.equal(frecency(0, undefined, now), 0);
});

test("a short token does not fuzzy-match a long body", () => {
  const prompt: Row = { ...relion, id: "p", category: "Prompt", title: "workflow", value: "summarizer analyzes zero-cost evidence and authorizes a final answer", tags: [] };
  // "zzz" is a subsequence of summarizer/analyzes/zero but not a word in the body.
  assert.equal(rankRows([prompt], "zzz").length, 0);
  assert.equal(rankRows([prompt], "cryo-EM").length, 0);
  assert.equal(rankRows([prompt], "analyzes").length, 1);
});

test("aliases are searched just below the title", () => {
  const row: Row = { ...relion, id: "ref", category: "Ref", title: "cryoem/eman2", value: "https://github.com/cryoem/eman2", tags: ["ref"], aliases: ["eman", "eman2"] };
  assert.equal(rankRows([row], "eman").length, 1);
  assert.equal(rankRows([row], "cryoem").length, 1);
  assert.equal(rankRows([row], "zzz").length, 0);
});

test("every query token must match, and usage breaks ties", () => {
  const base: Row = { ...relion, id: "a", category: "Note", title: "relion", value: "x", tags: [], uses: 0 };
  assert.equal(rankRows([base], "relion blurry").length, 0);
  const used: Row = { ...base, id: "b", uses: 9 };
  assert.deepEqual(rankRows([base, used], "relion").map((hit) => hit.row.id), ["b", "a"]);
});

test("fzf-style operators narrow without regex", () => {
  const row = (title: string, value: string, tags: string[] = []): Row => ({ ...relion, id: title, title, value, tags, category: "Note" });
  const rows = [row("relion", "https://github.com/3dem/relion"), row("relion-blurry", "https://example.com"), row("notes", "https://example.com/relion")];
  const ids = (query: string) => rankRows(rows, query).map((hit) => hit.row.id);
  assert.deepEqual(ids("^relion"), ["relion", "relion-blurry"]);
  assert.deepEqual(ids("blurry$"), ["relion-blurry"]);
  assert.deepEqual(ids("!blurry relion"), ["relion", "notes"]);
  assert.deepEqual(ids("'relion"), ["relion", "relion-blurry", "notes"]);
  assert.deepEqual(parseQuery("^rel !blurry").exact, ["^rel"]);
  assert.deepEqual(parseQuery("^rel !blurry").not, ["blurry"]);
  // A tag that starts with ! stays a tag, not a negation.
  assert.deepEqual(parseQuery("#!urgent").tags, ["!urgent"]);
});

test("github harvest counts repos and skips path segments", () => {
  const text = [
    "see https://github.com/3dem/relion/blob/master/README.md",
    "again https://github.com/3dem/relion.git",
    "https://github.com/earendil-works/pi/issues/1",
    "https://github.com/someone/issues/12",
  ].join("\n");
  const hits = githubHits(text);
  assert.deepEqual(
    hits.map((hit) => [hit.url, hit.n]),
    [
      ["https://github.com/3dem/relion", 2],
      ["https://github.com/earendil-works/pi", 1],
    ],
  );
});

test("harvest covers doi, arxiv, other urls, and a custom topic", () => {
  const text = [
    "repo https://github.com/3dem/relion",
    "paper https://doi.org/10.1038/s41592-024-02477-2 and again 10.1038/s41592-024-02477-2",
    "preprint https://arxiv.org/abs/2401.12345v2",
    "notes https://example.com/cryo/notes",
    "data EMPIAR-10443 and EMPIAR-10443",
  ].join("\n");
  const hits = harvestHits(text, [{ id: "empiar", category: "Data", tags: ["empiar"], pattern: "EMPIAR-\\d+" }]);
  const byTopic = Object.fromEntries(hits.map((hit) => [hit.topic, [hit.value, hit.n]]));
  assert.equal(byTopic.github?.[0], "https://github.com/3dem/relion");
  assert.equal(byTopic.doi?.[0], "https://doi.org/10.1038/s41592-024-02477-2");
  assert.equal(byTopic.doi?.[1], 2);
  assert.equal(byTopic.arxiv?.[0], "https://arxiv.org/abs/2401.12345");
  assert.equal(byTopic.url?.[0], "https://example.com/cryo/notes");
  assert.equal(byTopic.empiar?.[0], "EMPIAR-10443");
  assert.equal(byTopic.empiar?.[1], 2);
  assert.equal(hits.some((hit) => hit.topic === "url" && hit.value.includes("github.com")), false);
});

test("path token keeps a slash command and a partial directory", () => {
  assert.equal(pathToken("/add-dir "), "");
  assert.equal(pathToken("/add-dir"), "");
  assert.equal(pathToken("/add-dir ./src"), "./src");
  assert.equal(slashCommandToken("/new"), "/new");
  assert.equal(slashCommandToken("/quit"), "/quit");
  assert.equal(slashCommandToken("/add-dir ./src"), "");
  assert.equal(slashCommandToken("note /quit"), "");
  assert.equal(addDirArgument("/add-dir E:/in"), "E:/in");
  assert.equal(addDirArgument("/add-dir "), "");
  assert.equal(addDirArgument("/new E:/in"), null);
  assert.equal(isPathLikeToken("E:/in"), true);
  assert.equal(isPathLikeToken("rel"), false);
  assert.deepEqual(shelfCompletionContext("/shelf"), { kind: "action", prefix: "", bare: true });
  assert.deepEqual(shelfCompletionContext("/shelf ha"), { kind: "action", prefix: "ha", bare: false });
  assert.deepEqual(shelfCompletionContext("/shelf harvest "), { kind: "topic", prefix: "", bare: false });
  assert.deepEqual(shelfCompletionContext("/shelf prompt re"), { kind: "prompt", prefix: "re", bare: false });
  assert.deepEqual(slashCommandContext("/remove-dir pi-fabric"), { name: "remove-dir", args: "pi-fabric", bare: false });
  assert.deepEqual(slashCommandContext("  /remove-dir pi-fabric"), { name: "remove-dir", args: "pi-fabric", bare: false });
  assert.deepEqual(slashCommandContext("/remove-dir"), { name: "remove-dir", args: "", bare: true });
  assert.deepEqual(slashCommandContext("/add-dir ./src"), { name: "add-dir", args: "./src", bare: false });
  assert.deepEqual(slashCommandContext("/add-dir E:/in"), { name: "add-dir", args: "E:/in", bare: false });
  assert.equal(slashCommandContext("/data/pi"), null);
  assert.equal(slashCommandContext("note /remove-dir pi-fabric"), null);
  assert.equal(shelfQueryContext("plain target", false), null);
  assert.deepEqual(shelfQueryContext("plain target", true), { seed: "target", explicit: false });
  assert.deepEqual(shelfQueryContext("use @Prompt", false), { seed: "@Prompt", explicit: true });
  assert.equal(shelfQueryContext("foo@example.com", true), null);
  assert.equal(shelfQueryContext("issue#tag", true), null);
  assert.equal(shelfQueryContext("@", true), null);
  assert.equal(shelfQueryContext("/remove-dir pi-fabric", true), null);
  assert.equal(shelfQueryContext("./src", true), null);
  assert.equal(shelfInterceptionContext("/remove-dir pi-fabric", true).kind, "foreign-slash");
  assert.equal(shelfInterceptionContext("  /remove-dir pi-fabric", true).kind, "foreign-slash");
  assert.equal(shelfInterceptionContext("/remove-dir pi-fabric --force", true).kind, "foreign-slash");
  const midCommand = "/remove-dir pi-fabric --force";
  const midCursor = midCommand.indexOf("pi-fabric") + 3;
  assert.equal(shelfInterceptionContext(midCommand.slice(0, midCursor), true).kind, "foreign-slash");
  assert.equal(shelfInterceptionContext(midCommand.slice(0, midCommand.indexOf("--force")), true).kind, "foreign-slash");
  assert.equal(shelfInterceptionContext("/shelf ha", false).kind, "shelf-command");
  assert.equal(shelfInterceptionContext("/shelf unknown value", true).kind, "foreign-slash");
  assert.deepEqual(shelfInterceptionContext("/add-dir", true), { kind: "add-dir-path", path: "" });
  assert.deepEqual(shelfInterceptionContext("/add-dir ", true), { kind: "add-dir-path", path: "" });
  assert.deepEqual(shelfInterceptionContext("/add-dir E:/in", true), { kind: "add-dir-path", path: "E:/in" });
  // Pi keeps a bare /add-dir word until Tab explicitly asks for a fuzzy directory match.
  assert.equal(shelfInterceptionContext("/add-dir rel", false).kind, "foreign-slash");
  assert.deepEqual(shelfInterceptionContext("/add-dir rel", true), { kind: "add-dir-path", path: "rel" });
  assert.equal(shelfInterceptionContext("/add-dir rel", true).kind, "add-dir-path");
  assert.equal(shelfInterceptionContext("plain target", false).kind, "native");
  assert.equal(shelfInterceptionContext("plain target", true).kind, "shelf-query");
  assert.equal(rankPath("src/relion", "rel") < Infinity, true);
  assert.equal(rankPath("docs/readme", "rel"), Infinity);
  // fd prints directories with a trailing separator on Windows; the name must still rank.
  const backslash = String.fromCharCode(92);
  assert.equal(rankPath("src" + backslash, "src") < rankPath("test", "src"), true);
  assert.equal(rankPath("src/", "src") < rankPath("test", "src"), true);
  assert.equal(rankPath("src/", "src"), rankPath("src", "src"));
});

test("hotkey seed keeps the typed word and skips a bare slash command", () => {
  assert.equal(draftSeed("/add-dir rel"), "rel");
  assert.equal(draftSeed("/add-dir"), "");
  const slash = String.fromCharCode(92);
  assert.equal(isMachinePath("E:" + slash + "data" + slash + "relion"), true);
  assert.equal(isMachinePath(slash + slash + "server" + slash + "share"), true);
  assert.equal(isMachinePath("/data/relion"), true);
  assert.equal(isMachinePath("https://github.com/3dem/relion"), false);
  assert.equal(isMachinePath("./src"), false);
  const row: Item = { id: "1", category: "GitHub", title: "RELION", value: "https://github.com/3dem/relion", tags: ["cryo-em"], source: "manual", uses: 3, created: "", updated: "" };
  assert.equal(shelfMatches([row], "rel").length, 1);
  assert.equal(shelfMatches([row], "@Paper").length, 0);
  const same = [
    { ...row, id: "old", updated: "2026-01-01T00:00:00.000Z" },
    { ...row, id: "new", updated: "2026-02-01T00:00:00.000Z" },
  ];
  assert.deepEqual(shelfMatches(same, "RELION", true).map((hit) => hit.row.id), ["new", "old"]);
});

function row(over: Partial<Row> = {}): Row {
  return { id: "x", category: "Prompt", title: "t", value: "v", tags: [], source: "manual", uses: 0, created: "", updated: "", ...over };
}

test("selector labels stay on one line however long the value is", () => {
  const multi = label(row({ title: "complex-parallel", value: "Review this:\nstep 1: read\nstep 2: think\nstep 3: write" }));
  assert.equal(multi.includes("\n"), false);
  assert.ok(multi.includes("·4行"), "multi-line values are marked: " + multi);

  const long = label(row({ value: "https://github.com/3dem/relion/blob/master/README.md#installation-and-usage-notes-for-cryo-em" }));
  assert.equal(long.includes("\n"), false);
  assert.ok(long.length <= 74, "label fits an 80-column row: " + long.length);
  assert.ok(long.includes("…"), "clipped value is marked: " + long);

  // A CJK glyph is two terminal columns, so counting code units lets the row wrap.
  const cjk = label(row({ category: "论文", title: "冷冻电镜数据处理流程与重投影参数核对", value: "请检查 EMPIAR-10005 的 tilt 序列重建参数，确认 bin 与 dose 权重一致。" }));
  assert.equal(cjk.includes("\n"), false);
  assert.ok(displayWidth(cjk) <= 74, "label fits 74 columns: " + displayWidth(cjk));
  assert.ok(cjk.includes("…"), "clipped CJK value is marked");

  // Long titles, tag lists, and categories cannot push an option past one row either.
  assert.ok(label(row({ title: "x".repeat(200) })).length <= 74);
  assert.ok(label(row({ tags: Array.from({ length: 30 }, (_, i) => "tag" + i) })).length <= 74);
  assert.ok(label(row({ category: "C".repeat(200) })).length <= 74);

  // A single-line value is not marked and is shown whole.
  const plain = label(row({ title: "relion", value: "https://github.com/3dem/relion" }));
  assert.equal(plain.includes("行"), false);
  assert.ok(plain.includes("https://github.com/3dem/relion"));
});

test("choices disambiguate repeated labels and resolve by position", () => {
  const items = [
    row({ id: "a", value: "https://github.com/3dem/relion/blob/master/README.md#aaa" }),
    row({ id: "b", value: "https://github.com/3dem/relion/blob/master/README.md#bbb" }),
  ];
  // Clipping makes two different items render identically; the options must still differ.
  const list = choices(items, label);
  assert.equal(list.options.length, 2);
  assert.notEqual(list.options[0], list.options[1]);
  assert.equal(list.pick(list.options[1])?.id, "b");
  assert.equal(list.pick(list.options[0])?.id, "a");
  assert.equal(list.pick(undefined), undefined);
  assert.equal(list.pick("not an option"), undefined);

  // Identical labels are numbered rather than silently collapsed.
  const same = choices([row({ id: "a" }), row({ id: "b" })], () => "same");
  assert.deepEqual(same.options, ["same", "same  (2)"]);
  assert.equal(same.pick("same  (2)")?.id, "b");
});

test("github urls drop trailing sentence punctuation", () => {
  const hits = githubHits("see https://github.com/3dem/relion. and https://github.com/3dem/relion.git, done");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.url, "https://github.com/3dem/relion");
  assert.equal(hits[0]?.repo, "relion");
  assert.equal(hits[0]?.n, 2);
});

test("prompt detection uses category, prompt files, and explicit slots", () => {
  const plain = (value: string): Row => ({ ...relion, id: "p", category: "Note", title: "t", value });
  // $1 alone is shell syntax in a saved command, so it is not evidence of a prompt.
  assert.equal(isPromptRow(plain("run $1 now")), false);
  assert.equal(isPromptRow(plain("a ${x} b")), false);
  assert.equal(isPromptRow(plain("all $ARGUMENTS here")), false);
  assert.equal(isPromptRow(plain("join $@")), false);
  assert.equal(isPromptRow(plain("awk '{print $1}' data.txt")), false);
  assert.equal(isPromptRow(plain("Review {{focus}}.")), true);
  assert.equal(isPromptRow(plain("https://example.com/plain")), false);
  assert.equal(isPromptRow({ ...plain(""), category: "Prompt" }), true);
  assert.equal(isPromptRow({ ...plain(""), id: "prompt-file:global:review" }), true);
});

test("prompt files remain eligible for editor completion", () => {
  const prompt: Row = {
    id: "prompt-file:global:review",
    category: "Prompt",
    title: "review",
    value: "Review {{focus}}.",
    tags: ["pi-prompt"],
    source: "manual",
    uses: 0,
    created: "",
    updated: "",
    dynamic: true,
  };
  assert.equal(shelfMatches([prompt], "review").length, 1);
});
