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

test("a slot can name a value provider instead of a default", () => {
  const slots = templateSlots("Deploy {{branch=@branches}} to {{env=prod}} today");
  assert.equal(slots.length, 2);
  assert.equal(slots[0]?.provider, "branches");
  assert.equal(slots[0]?.fallback, "");
  assert.equal(slots[1]?.provider, undefined);
  assert.equal(slots[1]?.fallback, "prod");
  assert.equal(fillTemplate("{{branch=@branches}}", { branch: "main" }), "main");
});

test("a saved shell command keeps its own $ placeholders", () => {
  // These are commands, not prompts: expanding them silently deletes characters.
  assert.equal(applyPositionals("awk '{print $1}' data.txt", []), "awk '{print $1}' data.txt");
  assert.equal(applyPositionals('for f in "$@"; do echo "$f"; done', []), 'for f in "$@"; do echo "$f"; done');
  assert.equal(applyPositionals("git log --pretty=format:%h $@", []), "git log --pretty=format:%h $@");
  assert.equal(applyPositionals("Next ${@:9}", ["a"]), "Next ${@:9}");
  assert.equal(applyPositionals("echo $1foo and jQuery $1bar", ["x"]), "echo $1foo and jQuery $1bar");
  assert.equal(applyPositionals("escaped \\$1 stays", ["x"]), "escaped \\$1 stays");
  // A prompt that does supply arguments still expands them.
  assert.equal(applyPositionals("Review $1 now", ["security"]), "Review security now");
  assert.equal(applyPositionals("all $ARGUMENTS here", ["a", "b"]), "all a b here");
});
