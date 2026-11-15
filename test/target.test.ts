import assert from "node:assert/strict";
import test from "node:test";
import { parseTarget } from "../src/target.ts";

test("GitHub URLs canonicalize to owner/repo", () => {
  assert.equal(parseTarget("https://github.com/cryoem/eman2")?.value, "https://github.com/cryoem/eman2");
  assert.equal(parseTarget("https://github.com/3dem/relion.git")?.value, "https://github.com/3dem/relion");
  assert.equal(parseTarget("github.com/earendil-works/pi/tree/main")?.value, "https://github.com/earendil-works/pi");
  assert.equal(parseTarget("earendil-works/pi")?.value, "https://github.com/earendil-works/pi");
  assert.equal(parseTarget("https://github.com/cryoem/eman2")?.label, "cryoem/eman2");
});

test("DOI, arXiv and generic URLs keep one exact target", () => {
  assert.equal(parseTarget("10.1038/s41592-024-02477-2")?.value, "https://doi.org/10.1038/s41592-024-02477-2");
  assert.equal(parseTarget("https://arxiv.org/abs/2401.01234v2")?.value, "https://arxiv.org/abs/2401.01234");
  assert.equal(parseTarget("https://example.com/a?x=1")?.value, "https://example.com/a?x=1");
});

test("nonsense is rejected rather than stored", () => {
  assert.equal(parseTarget("not a url"), null);
  assert.equal(parseTarget(""), null);
});
