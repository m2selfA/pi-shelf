import assert from "node:assert/strict";
import test from "node:test";
import { completionKey, completionScores, emptyCompletionStats, parseCompletionStats, recordCompletion } from "../src/completions.ts";

test("all spellings of a prefix share one statistics key", () => {
  assert.equal(completionKey("web-"), "web");
  assert.equal(completionKey("web_"), "web");
  assert.equal(completionKey("web__"), "web");
  assert.equal(completionKey("pi-ssh"), "pi_ssh");
  assert.equal(completionKey("mcp__github__"), "mcp_github");
});

test("accepting a candidate records uses and ranks it for the same prefix", () => {
  const stats = emptyCompletionStats();
  const now = Date.parse("2026-06-01T00:00:00Z");
  recordCompletion(stats, "web-", "web_search", now);
  recordCompletion(stats, "web_", "web_search", now + 1000);
  recordCompletion(stats, "web-", "web_fetch", now);
  const scores = completionScores(stats, "web-", now + 2000);
  assert.ok((scores.get("web_search") ?? 0) > (scores.get("web_fetch") ?? 0));
  assert.equal(completionScores(stats, "ssh-", now).size, 0);
});

test("malformed statistics are ignored instead of crashing", () => {
  const stats = parseCompletionStats({ tokens: { web: { web_search: { uses: "2", lastUsed: "2026-01-01" }, bad: { uses: 0 } }, broken: 3 } });
  assert.deepEqual(stats.tokens, { web: { web_search: { uses: 2, lastUsed: "2026-01-01" } } });
  assert.deepEqual(parseCompletionStats(null), emptyCompletionStats());
});

test("statistics keep at most twenty values per prefix", () => {
  const stats = emptyCompletionStats();
  for (let index = 0; index < 25; index += 1) recordCompletion(stats, "web-", "tool_" + index, 1000 + index);
  assert.equal(Object.keys(stats.tokens.web ?? {}).length, 20);
  assert.ok(!("tool_0" in (stats.tokens.web ?? {})));
});
