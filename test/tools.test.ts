import assert from "node:assert/strict";
import test from "node:test";
import { rankTools, toolToken } from "../src/tools.ts";

test("a token with an underscore opens by itself; a bare word waits for Tab", () => {
  assert.deepEqual(toolToken("please run web_", false), { prefix: "web_", auto: true });
  assert.deepEqual(toolToken("use mcp__github__se", false), { prefix: "mcp__github__se", auto: true });
  assert.equal(toolToken("please run web", false), null);
  assert.deepEqual(toolToken("please run web", true), { prefix: "web", auto: false });
});

test("commands, attachments and tags are not tool tokens", () => {
  assert.equal(toolToken("/web", true), null);
  assert.equal(toolToken("@web", true), null);
  assert.equal(toolToken("#web", true), null);
  assert.equal(toolToken("x", true), null);
});

const tools = [
  { name: "web_search", description: "Search the web and return results", exposure: "direct", sourceInfo: { source: "builtin" } },
  { name: "web_fetch", description: "Fetch a URL", exposure: "direct", sourceInfo: { source: "builtin" } },
  { name: "mcp__github__search_code", description: "Search code", exposure: "direct", namespace: { name: "mcp__github" }, sourceInfo: { source: "builtin" } },
  { name: "read", description: "Read files", exposure: "direct", sourceInfo: { source: "builtin" } },
  { name: "secret", description: "hidden", exposure: "hidden" },
];

test("exact and prefix matches rank before segment hits", () => {
  const names = rankTools(tools, "web_").map((tool) => tool.name);
  assert.deepEqual(names, ["web_fetch", "web_search"]);
  const segments = rankTools(tools, "sear").map((tool) => tool.name);
  assert.deepEqual(segments, ["web_search", "mcp__github__search_code"]);
});

test("active tools win ties and hidden tools never show", () => {
  const names = rankTools(tools, "web_", ["web_search"]).map((tool) => tool.name);
  assert.deepEqual(names, ["web_search", "web_fetch"]);
  assert.ok(!rankTools(tools, "se").some((tool) => tool.name === "secret"));
});

test("descriptions carry the source and the activation state", () => {
  const [github] = rankTools(tools, "mcp__github__", ["mcp__github__search_code"]);
  assert.equal(github?.description, "MCP github · Search code");
  const [inactive] = rankTools(tools, "web_fetch", []);
  assert.match(inactive?.description ?? "", /内置 · 未启用/);
});
