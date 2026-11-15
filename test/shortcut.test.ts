import assert from "node:assert/strict";
import test from "node:test";
import { expandShortcuts } from "../src/shortcut.ts";

const entries = [
  { title: "review", value: "Review the diff carefully." },
  { title: "style", value: "Use strict TypeScript." },
  { title: "dup", value: "first" },
  { title: "dup", value: "second" },
];

test("a ;name token expands to its value", () => {
  assert.equal(expandShortcuts("please ;review this", entries), "please Review the diff carefully. this");
  assert.equal(expandShortcuts(";style", entries), "Use strict TypeScript.");
});

test("several tokens expand in one message", () => {
  assert.equal(expandShortcuts(";style and ;review", entries), "Use strict TypeScript. and Review the diff carefully.");
});

test("unknown and duplicate titles are left alone", () => {
  assert.equal(expandShortcuts(";missing stays", entries), null);
  assert.equal(expandShortcuts(";dup stays", entries), null);
});

test("a semicolon inside a word is not a trigger", () => {
  assert.equal(expandShortcuts("x;review", entries), null);
  assert.equal(expandShortcuts("a;review b", entries), null);
});

test("the full-width semicolon works too", () => {
  // The token itself disappears; the surrounding text is left byte-for-byte.
  assert.equal(expandShortcuts("请；review 这段", entries), "请Review the diff carefully. 这段");
});
