import assert from "node:assert/strict";
import test from "node:test";
import { checkUrl, enrichTarget, enrichUrl, type FetchLike } from "../src/enrich.ts";

function fakeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string }>): FetchLike {
  const calls: string[] = [];
  const impl: FetchLike & { calls: string[] } = Object.assign(
    async (url: string) => {
      calls.push(url);
      const route = routes[url];
      if (!route) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
      const status = route.status ?? 200;
      return {
        ok: status < 400,
        status,
        text: async () => route.text ?? "",
        json: async () => route.json ?? {},
      };
    },
    { calls },
  );
  return impl;
}

test("each URL shape maps to the right endpoint", () => {
  assert.equal(enrichTarget("https://github.com/3dem/relion")?.kind, "github");
  assert.equal(enrichTarget("https://github.com/3dem/relion.git")?.api, "https://api.github.com/repos/3dem/relion");
  assert.equal(enrichTarget("https://doi.org/10.1038/s41592-024-02477-2")?.kind, "doi");
  assert.equal(enrichTarget("https://arxiv.org/abs/2401.01234v2")?.api, "https://export.arxiv.org/api/query?id_list=2401.01234");
  assert.equal(enrichTarget("https://example.com/page")?.kind, "generic");
  assert.equal(enrichTarget("not a url"), null);
});

test("github enrichment returns the repository name and topics", async () => {
  const fetchImpl = fakeFetch({
    "https://api.github.com/repos/3dem/relion": { json: { full_name: "3dem/relion", description: "Image processing", topics: ["cryo-em", "relion"] } },
  });
  const result = await enrichUrl("https://github.com/3dem/relion", fetchImpl);
  assert.equal(result.title, "3dem/relion");
  assert.deepEqual(result.tags, ["cryo-em", "relion"]);
});

test("doi enrichment strips markup from the title", async () => {
  const fetchImpl = fakeFetch({
    "https://doi.org/10.1038/s41592-024-02477-2": { json: { title: "<i>AreTomo3</i>: a tool", author: [{ family: "Chen" }] } },
  });
  const result = await enrichUrl("https://doi.org/10.1038/s41592-024-02477-2", fetchImpl);
  assert.equal(result.title, "AreTomo3: a tool");
  assert.deepEqual(result.tags, ["chen"]);
});

test("arxiv enrichment reads the atom entry title", async () => {
  const atom = "<feed><entry><title>  Cryo-EM  processing\n  at scale </title></entry></feed>";
  const result = await enrichUrl("https://arxiv.org/abs/2401.01234", fakeFetch({ "https://export.arxiv.org/api/query?id_list=2401.01234": { text: atom } }));
  assert.equal(result.title, "Cryo-EM processing at scale");
});

test("generic pages prefer og:title and decode entities", async () => {
  const html = '<html><head><meta property="og:title" content="Relion &amp; friends"></head></html>';
  const result = await enrichUrl("https://example.com/page", fakeFetch({ "https://example.com/page": { text: html } }));
  assert.equal(result.title, "Relion & friends");
});

test("checkUrl uses the GitHub API so a proxied HTML host does not matter", async () => {
  const fetchImpl = fakeFetch({ "https://api.github.com/repos/3dem/relion": { json: { full_name: "3dem/relion" } } });
  const alive = await checkUrl("https://github.com/3dem/relion", fetchImpl);
  assert.deepEqual(alive, { ok: true, status: 200 });
  const missing = fakeFetch({});
  const dead = await checkUrl("https://github.com/3dem/relion", missing);
  assert.equal(dead.ok, false);
  assert.equal(dead.status, 404);
});

test("checkUrl falls back to GET when HEAD is rejected", async () => {
  const fetchImpl = fakeFetch({ "https://example.com/a": { status: 405 } });
  const head = await checkUrl("https://example.com/a", fetchImpl);
  assert.equal(head.status, 405);
  assert.equal(head.ok, false);
  const okFetch: FetchLike = async (_url, init) => ({ ok: true, status: init?.method === "HEAD" ? 405 : 200, text: async () => "", json: async () => ({}) });
  assert.deepEqual(await checkUrl("https://example.com/a", okFetch), { ok: true, status: 200 });
  const broken: FetchLike = async () => {
    throw new Error("dns failure");
  };
  const failed = await checkUrl("https://example.com/a", broken);
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /dns failure/);
  // A bot wall is not a dead link.
  const blocked: FetchLike = async () => ({ ok: false, status: 403, text: async () => "", json: async () => ({}) });
  assert.equal((await checkUrl("https://example.com/a", blocked)).ok, true);
  // A timeout is not evidence of a dead link either.
  const slow: FetchLike = async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  const timedOut = await checkUrl("https://example.com/a", slow);
  assert.equal(timedOut.ok, true);
  assert.match(timedOut.error ?? "", /超时/);
});
