import assert from "node:assert/strict";
import test from "node:test";
import { draftSeed, githubHits, harvestHits, isMachinePath, parseQuery, pathToken, rankPath, score, shelfMatches, type Item, type Row } from "../src/match.ts";

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
  assert.equal(byTopic.github[0], "https://github.com/3dem/relion");
  assert.equal(byTopic.doi[0], "https://doi.org/10.1038/s41592-024-02477-2");
  assert.equal(byTopic.doi[1], 2);
  assert.equal(byTopic.arxiv[0], "https://arxiv.org/abs/2401.12345");
  assert.equal(byTopic.url[0], "https://example.com/cryo/notes");
  assert.equal(byTopic.empiar[0], "EMPIAR-10443");
  assert.equal(byTopic.empiar[1], 2);
  assert.equal(hits.some((hit) => hit.topic === "url" && hit.value.includes("github.com")), false);
});

test("path token keeps a slash command and a partial directory", () => {
  assert.equal(pathToken("/add-dir "), "");
  assert.equal(pathToken("/add-dir"), "");
  assert.equal(pathToken("/add-dir ./src"), "./src");
  assert.equal(rankPath("src/relion", "rel") < Infinity, true);
  assert.equal(rankPath("docs/readme", "rel"), Infinity);
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
