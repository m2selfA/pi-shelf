export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export type Enrichment = { title?: string; tags: string[]; description?: string };

const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:[?#].*)?$/;
const DOI = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$/;
const ARXIV = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/;

export type EnrichTarget =
  | { kind: "github"; api: string; headers: Record<string, string> }
  | { kind: "doi"; api: string; headers: Record<string, string> }
  | { kind: "arxiv"; api: string; headers: Record<string, string> }
  | { kind: "generic"; api: string; headers: Record<string, string> };

/**
 * Map a saved URL to the cheapest endpoint that returns a title. GitHub and DOI have
 * JSON APIs; arXiv only offers Atom; everything else falls back to the page <title>.
 */
export function enrichTarget(url: string): EnrichTarget | null {
  const text = url.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  const github = text.match(GITHUB);
  if (github) {
    return {
      kind: "github",
      api: `https://api.github.com/repos/${github[1]}/${github[2]!.replace(/\.git$/, "")}`,
      headers: { accept: "application/vnd.github+json", "user-agent": "pi-shelf" },
    };
  }
  const doi = text.match(DOI);
  if (doi) {
    return {
      kind: "doi",
      api: `https://doi.org/${doi[1]}`,
      headers: { accept: "application/vnd.citationstyles.csl+json", "user-agent": "pi-shelf" },
    };
  }
  const arxiv = text.match(ARXIV);
  if (arxiv) {
    return {
      kind: "arxiv",
      api: `https://export.arxiv.org/api/query?id_list=${arxiv[1]}`,
      headers: { "user-agent": "pi-shelf" },
    };
  }
  return { kind: "generic", api: text, headers: { "user-agent": "pi-shelf", accept: "text/html" } };
}

function decodeEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function metaTitle(html: string) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title?.[1] ? decodeEntities(title[1]).replace(/\s+/g, " ").trim() : undefined;
}

function arxivTitle(atom: string) {
  const entry = atom.split(/<entry>/i)[1] ?? atom;
  const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title?.[1] ? decodeEntities(title[1]).replace(/\s+/g, " ").trim() : undefined;
}

function withTimeout(timeoutMs: number) {
  // AbortSignal.timeout exists on Node 18+; the fallback keeps the module usable in tests
  // that replace the timer functions.
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

export async function enrichUrl(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 6000): Promise<Enrichment> {
  const target = enrichTarget(url);
  if (!target) return { tags: [] };
  const response = await fetchImpl(target.api, { headers: target.headers, signal: withTimeout(timeoutMs) });
  if (!response.ok) return { tags: [] };
  if (target.kind === "github") {
    const data = (await response.json()) as { full_name?: string; description?: string; topics?: string[] };
    return {
      title: data.full_name,
      description: data.description,
      tags: Array.isArray(data.topics) ? data.topics.slice(0, 6) : [],
    };
  }
  if (target.kind === "doi") {
    const data = (await response.json()) as { title?: string; author?: Array<{ family?: string }> };
    const first = data.author?.[0]?.family;
    return { title: data.title ? String(data.title).replace(/<[^>]+>/g, "").trim() : undefined, tags: first ? [first.toLowerCase()] : [] };
  }
  const text = await response.text();
  return { title: target.kind === "arxiv" ? arxivTitle(text) : metaTitle(text), tags: [] };
}

export type CheckResult = { ok: boolean; status?: number; error?: string };

/** 401/403/429 mean "we cannot tell", not "dead": many sites block HEAD or bots. */
const INCONCLUSIVE = new Set([401, 403, 429]);

/**
 * HEAD first, GET when the server rejects HEAD; any 2xx/3xx counts as alive.
 * GitHub/DOI/arXiv are checked through their API, because the HTML host is frequently
 * unreachable from behind a proxy even when the repository exists.
 */
export async function checkUrl(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 8000): Promise<CheckResult> {
  const api = enrichTarget(url);
  if (api && api.kind !== "generic") {
    try {
      const response = await fetchImpl(api.api, { headers: api.headers, signal: withTimeout(timeoutMs) });
      if (response.status === 404) return { ok: false, status: 404 };
      if (INCONCLUSIVE.has(response.status)) return { ok: true, status: response.status, error: "需要登录或被限流，未判定" };
      return { ok: response.status < 400, status: response.status };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const unknown = /abort|timeout|timed out/i.test(message) || ["TimeoutError", "AbortError"].includes((error as Error).name);
      if (unknown) return { ok: true, error: `超时，未判定：${message.slice(0, 110)}` };
      // A failed API lookup is not proof the page is gone; fall through to the page check.
    }
  }
  try {
    const head = await fetchImpl(url, { method: "HEAD", signal: withTimeout(timeoutMs) });
    if (head.status !== 405 && head.status !== 501 && head.status !== 403) {
      return { ok: head.status < 400, status: head.status };
    }
    const get = await fetchImpl(url, { method: "GET", signal: withTimeout(timeoutMs) });
    if (INCONCLUSIVE.has(get.status)) return { ok: true, status: get.status, error: "需要登录或被限流，未判定" };
    return { ok: get.status < 400, status: get.status };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    // A timeout says nothing about the page; DNS refusal and 404s do.
    const unknown = /abort|timeout|timed out/i.test(message) || ["TimeoutError", "AbortError"].includes((error as Error).name);
    return { ok: unknown, error: `${unknown ? "超时，未判定：" : ""}${message.slice(0, 110)}` };
  }
}
