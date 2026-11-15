import assert from "node:assert/strict";
import test from "node:test";
import { composeParts } from "../src/compose.ts";

test("prepend and append parts wrap the ordinary ones", () => {
  const text = composeParts([
    { text: "tail", placement: "append" },
    { text: "head", placement: "prepend" },
    { text: "body" },
  ]);
  assert.equal(text, "head\n\nbody\n\ntail");
});

test("order breaks ties inside a group and unnumbered parts sort as 0", () => {
  const text = composeParts([
    { text: "second", order: 2 },
    { text: "first", order: 1 },
    { text: "same-a" },
    { text: "same-b" },
  ]);
  assert.equal(text, "same-a\n\nsame-b\n\nfirst\n\nsecond");
});

test("blank parts are dropped and whitespace is trimmed", () => {
  assert.equal(composeParts([{ text: "  a  " }, { text: "   " }, { text: "b" }], " "), "a b");
  assert.equal(composeParts([]), "");
});
