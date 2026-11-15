import assert from "node:assert/strict";
import test from "node:test";
import { aliasKeyValid, expandAlias, matchAliases } from "../src/alias.ts";

const now = new Date(2026, 10, 15, 9, 5);

test("date, time and datetime use the local clock", () => {
  assert.equal(expandAlias("{{date}} {{time}} {{datetime}}", { now }).text, "2026-11-15 09:05 2026-11-15 09:05");
});

test("clipboard expands when available and stays visible when it is not", () => {
  assert.equal(expandAlias("copy: {{clipboard}}", { now, clipboard: "hello" }).text, "copy: hello");
  assert.equal(expandAlias("copy: {{clipboard}}", { now }).text, "copy: {{clipboard}}");
});

test("cursor marks the caret and disappears from the text", () => {
  const expanded = expandAlias("git commit -m '{{cursor}}'", { now });
  assert.equal(expanded.text, "git commit -m ''");
  assert.equal(expanded.cursorOffset, 15);
  assert.equal(expandAlias("a{{cursor}}b{{cursor}}c", { now }).text, "abc");
});

test("random picks from the supplied choices", () => {
  assert.equal(expandAlias("{{random:red|green|blue}}", { now, random: () => 0.99 }).text, "blue");
  assert.equal(expandAlias("{{random:red|green}}", { now, random: () => 0 }).text, "red");
});

test("environment variables expand and missing ones stay literal", () => {
  assert.equal(expandAlias("home={{env:HOME}}", { now, env: { HOME: "/home/me" } }).text, "home=/home/me");
  assert.equal(expandAlias("missing={{env:NOPE}}", { now, env: {} }).text, "missing={{env:NOPE}}");
});

test("image paths from clipboard or screenshot expand as text", () => {
  assert.equal(expandAlias("{{clipboard-image}} {{screenshot}}", { now, clipboardImage: "/tmp/a.png", screenshot: "/tmp/s.png" }).text, "/tmp/a.png /tmp/s.png");
  assert.equal(expandAlias("{{clipboard-image}}", { now }).text, "{{clipboard-image}}");
});

test("unknown macros stay literal and keys are validated", () => {
  assert.equal(expandAlias("{{shell:rm -rf /}}", { now }).text, "{{shell:rm -rf /}}");
  assert.equal(aliasKeyValid("ws"), true);
  assert.equal(aliasKeyValid("w"), false);
  assert.equal(aliasKeyValid("has space"), false);
});

test("aliases match exactly before prefix and ignore short queries", () => {
  const aliases = [{ key: "ws", value: "web_search" }, { key: "wssh", value: "ssh" }, { key: "xb", value: "D:/bucket" }];
  assert.deepEqual(matchAliases(aliases, "ws").map((hit) => hit.alias.key), ["ws", "wssh"]);
  assert.deepEqual(matchAliases(aliases, "w").length, 0);
  assert.deepEqual(matchAliases(aliases, "xb").map((hit) => hit.alias.value), ["D:/bucket"]);
});
