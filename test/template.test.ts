import assert from "node:assert/strict";
import test from "node:test";
import { applyPositionals, fillTemplate, parsePromptMarkdown, sessionExcerpt, sessionFolder, splitArgs, templateSlots } from "../src/template.ts";

test("template slots keep choices and one answer fills every copy", () => {
  const value = "用 {{tool:AreTomo3|IMOD}} 重建 {{sample}}，bin {{bin=4}}。再用 {{tool}}查看。";
  const slots = templateSlots(value);
  assert.deepEqual(slots.map((slot) => slot.name), ["tool", "sample", "bin"]);
  assert.deepEqual(slots[0]?.choices, ["AreTomo3", "IMOD"]);
  assert.equal(slots[2]?.fallback, "4");
  assert.equal(fillTemplate(value, { tool: "AreTomo3", sample: "EMPIAR-10005", bin: "4" }).includes("AreTomo3 重建 EMPIAR-10005"), true);
  assert.equal(fillTemplate(value, { tool: "AreTomo3", sample: "EMPIAR-10005", bin: "4" }).includes("{{tool}}"), false);
});

test("past session excerpts keep user text and the folder matches pi", () => {
  const slash = String.fromCharCode(92);
  assert.equal(sessionFolder("E:" + slash + "inter" + slash + "pi"), "--E--inter-pi--");
  const jsonl = [
    JSON.stringify({ type: "message", message: { role: "user", content: "把 tilt 重建写成可复用步骤" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } }),
    JSON.stringify({ type: "message", message: { role: "user", content: "样品是 EMPIAR-10005" } }),
  ].join("\n");
  const excerpt = sessionExcerpt(jsonl, 200);
  assert.equal(excerpt.title, "把 tilt 重建写成可复用步骤");
  assert.equal(excerpt.excerpt.includes("EMPIAR-10005"), true);
  assert.equal(excerpt.excerpt.includes("好"), false);
});
test("pi prompt files keep frontmatter and positional arguments", () => {
  const parsed = parsePromptMarkdown("---\ndescription: Review staged git changes\nargument-hint: \"[focus]\"\n---\nReview ${1:-correctness}.\n");
  assert.equal(parsed.description, "Review staged git changes");
  assert.equal(parsed.argumentHint, "[focus]");
  assert.equal(applyPositionals(parsed.body.trim(), []), "Review correctness.");
  assert.equal(applyPositionals("Look at $1 and $@", ["security"]), "Look at security and security");
  assert.equal(applyPositionals("Next ${@:2:1}", ["a", "b", "c"]), "Next b");
  assert.equal(applyPositionals("Missing $1", []).includes("{{$1}}"), true);
  assert.deepEqual(splitArgs('review "API compatibility" extra'), ["review", "API compatibility", "extra"]);
});
