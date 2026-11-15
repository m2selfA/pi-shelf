import assert from "node:assert/strict";
import test from "node:test";
import { packageIdentity, rankPackages, rankTools, toolToken } from "../src/tools.ts";

test("a token with an underscore opens by itself; a bare word waits for Tab", () => {
  assert.deepEqual(toolToken("please run web_", false), { prefix: "web_", auto: true });
  assert.deepEqual(toolToken("use mcp__github__se", false), { prefix: "mcp__github__se", auto: true });
  assert.equal(toolToken("please run web", false), null);
  assert.deepEqual(toolToken("please run web", true), { prefix: "web", auto: false });
});

test("underscore activates, hyphen only matches on an explicit completion request", () => {
  assert.deepEqual(toolToken("use web_", false), { prefix: "web_", auto: true });
  assert.equal(toolToken("use web-", false), null);
  assert.equal(toolToken("use pi-ssh", false), null);
  assert.deepEqual(toolToken("use web-", true), { prefix: "web-", auto: false });
  assert.deepEqual(toolToken("use pi-ssh", true), { prefix: "pi-ssh", auto: false });
  assert.equal(toolToken("plainword", false), null);
});

test("- and _ match each other in tool names", () => {
  const tools = [
    { name: "web_search", description: "Search", exposure: "direct" },
    { name: "web_fetch", description: "Fetch", exposure: "direct" },
    { name: "web__run", description: "Run", exposure: "direct" },
    { name: "mcp__github__search_code", description: "Code", exposure: "direct" },
  ];
  assert.deepEqual(rankTools(tools, "web-").map((tool) => tool.name).sort(), ["web__run", "web_fetch", "web_search"]);
  assert.deepEqual(rankTools(tools, "web_").map((tool) => tool.name).sort(), ["web__run", "web_fetch", "web_search"]);
  assert.deepEqual(rankTools(tools, "mcp-github-").map((tool) => tool.name), ["mcp__github__search_code"]);
  assert.deepEqual(rankTools([{ name: "web-search", exposure: "direct" }], "web_").map((tool) => tool.name), ["web-search"]);
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

test("package identity comes from the npm spec, the manifest or the entry file", () => {
  assert.deepEqual(packageIdentity("npm:@hackxit/pi-ssh-tools", "x"), { name: "pi-ssh-tools", fullName: "@hackxit/pi-ssh-tools", aliases: ["@hackxit/pi-ssh-tools", "pi-ssh-tools"] });
  assert.deepEqual(packageIdentity("E:/repos/pi-runs", "E:/repos/pi-runs/extensions/runs/index.ts", "pi-runs"), { name: "pi-runs", fullName: "pi-runs", aliases: ["pi-runs"] });
  assert.deepEqual(packageIdentity("auto", "C:/agent/extensions/search-boost.js"), { name: "search-boost", fullName: "search-boost", aliases: ["search-boost"] });
  assert.equal(packageIdentity("builtin", "builtin:read"), null);
});

test("a plugin alias finds its tools without knowing their names", () => {
  const pluginTools = [
    { name: "ssh_list_hosts", description: "List hosts", exposure: "direct", packageName: "pi-ssh-tools", packageFullName: "@hackxit/pi-ssh-tools", packageAliases: ["@hackxit/pi-ssh-tools", "pi-ssh-tools"], sourceInfo: { source: "npm:@hackxit/pi-ssh-tools" } },
    { name: "ssh_upload", description: "Upload", exposure: "direct", packageName: "pi-ssh-tools", packageFullName: "@hackxit/pi-ssh-tools", packageAliases: ["@hackxit/pi-ssh-tools", "pi-ssh-tools"], sourceInfo: { source: "npm:@hackxit/pi-ssh-tools" } },
    { name: "runs_submit", description: "Submit", exposure: "direct", packageName: "pi-runs", packageAliases: ["pi-runs"], sourceInfo: { source: "E:/repos/pi-runs" } },
  ];
  assert.deepEqual(rankTools(pluginTools, "pi-ssh").map((tool) => tool.name), ["ssh_upload", "ssh_list_hosts"]);
  assert.match(rankTools(pluginTools, "pi-ssh")[0]?.description ?? "", /pi-ssh-tools/);
  assert.deepEqual(rankTools(pluginTools, "ssh_").map((tool) => tool.name), ["ssh_upload", "ssh_list_hosts"]);
  const packages = rankPackages(pluginTools, "pi-ssh");
  assert.equal(packages[0]?.name, "pi-ssh-tools");
  assert.equal(packages[0]?.toolCount, 2);
  assert.match(packages[0]?.description ?? "", /2 个工具/);
  // A tool-name query must not drag the plugin row in as a substring hit.
  assert.equal(rankPackages(pluginTools, "ssh_").length, 0);
});

test("descriptions carry the source and the activation state", () => {
  const [github] = rankTools(tools, "mcp__github__", ["mcp__github__search_code"]);
  assert.equal(github?.description, "MCP github · Search code");
  const [inactive] = rankTools(tools, "web_fetch", []);
  assert.match(inactive?.description ?? "", /内置 · 未启用/);
});
