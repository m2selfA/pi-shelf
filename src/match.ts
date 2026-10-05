import { templateSlots } from "./template.ts";

export type Item = {
  id: string;
  category: string;
  title: string;
  value: string;
  tags: string[];
  source: "manual" | "agent" | "pinned";
  uses: number;
  created: string;
  updated: string;
};

export type Row = Item & { dynamic?: boolean; scope?: "global" | "project" };

export type Query = { tags: string[]; category: string; text: string };

const GITHUB = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\/\s)"'`]|$)/gi;
const SKIP_REPO = new Set(["pull", "pulls", "issues", "blob", "tree", "commit", "commits", "actions", "releases"]);

export function normTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))];
}

export function parseQuery(raw: string): Query {
  const tags: string[] = [];
  let category = "";
  const words: string[] = [];
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    if (part.startsWith("#")) tags.push(part.slice(1).toLowerCase());
    else if (part.startsWith("@")) category = part.slice(1).toLowerCase();
    else words.push(part.toLowerCase());
  }
  return { tags, category, text: words.join(" ") };
}

export function fuzzy(hay: string, needle: string) {
  if (!needle) return 0;
  const h = hay.toLowerCase();
  if (h === needle) return 0;
  if (h.startsWith(needle)) return 1;
  if (h.includes(needle)) return 2;
  let i = 0;
  for (const ch of h) if (ch === needle[i]) i += 1;
  return i === needle.length ? 3 : Infinity;
}

export function quotePath(value: string) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function pathToken(text: string) {
  const token = text.match(/\S*$/)?.[0] ?? "";
  if (!token || /^\/[A-Za-z0-9_-]+$/.test(token)) return "";
  if (token.startsWith(".") || token.startsWith("~") || token.includes("/") || token.includes("\\")) return token;
  return "";
}

export function draftSeed(text: string) {
  const token = text.match(/\S*$/)?.[0] ?? "";
  if (!token) return "";
  if (token.startsWith("/") && !token.slice(1).includes("/")) return "";
  return token;
}

export function slashCommandToken(text: string) {
  const token = text.match(/\S*$/)?.[0] ?? "";
  if (!token.startsWith("/")) return "";
  if (text.slice(0, text.length - token.length).trim() !== "") return "";
  if (token.slice(1).includes("/") || token.slice(1).includes("\\")) return "";
  return token;
}

export function addDirArgument(text: string) {
  const match = text.match(/^\s*\/add-dir(?:\s+(\S*))?\s*$/);
  return match ? match[1] ?? "" : null;
}

export function isPathLikeToken(value: string) {
  const token = value.trim();
  return token === "" || token.startsWith(".") || token.startsWith("~") || token.startsWith("/") || token.startsWith("\\") || token.includes("/") || token.includes("\\");
}

export function isMachinePath(value: string) {
  const text = value.trim();
  if (text.includes("://")) return false;
  const slash = String.fromCharCode(92);
  if (text.startsWith("~/") || text.startsWith("~" + slash)) return true;
  if (text.startsWith("/") || text.startsWith(slash)) return true;
  const drive = text[0] ?? "";
  return /^[A-Za-z]$/.test(drive) && text[1] === ":" && (text[2] === slash || text[2] === "/");
}

export function shelfMatches(rows: Row[], token: string, forced = false) {
  const queryText = token.trim();
  if (!forced && queryText.length < 2 && !queryText.startsWith("@") && !queryText.startsWith("#")) return [];
  const query = parseQuery(queryText);
  return rows
    .map((row) => ({ row, rank: score(row, query) }))
    .filter((hit) => hit.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || b.row.uses - a.row.uses || a.row.title.localeCompare(b.row.title))
    .slice(0, 8);
}

export function rankPath(path: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return 4;
  const base = path.split(/[\\/]/).pop() ?? path;
  return Math.min(fuzzy(base, q), fuzzy(path.replaceAll("\\", "/"), q) + 1);
}

export function score(row: Pick<Row, "category" | "title" | "value" | "tags">, query: Query) {
  if (query.category && fuzzy(row.category, query.category) === Infinity) return Infinity;
  const tags = normTags(row.tags);
  if (query.tags.some((tag) => !tags.includes(tag))) return Infinity;
  if (!query.text) return 4;
  return Math.min(
    fuzzy(row.title, query.text),
    fuzzy(row.value, query.text),
    fuzzy(tags.join(" "), query.text),
    fuzzy(row.category, query.text),
  );
}

export function label(row: Row) {
  const tags = row.tags.length ? " #" + row.tags.join(" #") : "";
  const marks = [row.dynamic ? " ·dyn" : "", row.scope === "project" ? " ·repo" : "", templateSlots(row.value).length ? " ·tpl" : ""].join("");
  return `@${row.category}  ${row.title}${tags}${marks}  →  ${row.value}`;
}

export type GithubHit = { url: string; owner: string; repo: string; n: number };

export type TopicDef = { id: string; category: string; tags: string[]; pattern: string };

export type HarvestHit = {
  topic: string;
  category: string;
  title: string;
  value: string;
  tags: string[];
  n: number;
};

export const BUILTIN_TOPICS = ["github", "doi", "arxiv", "url"] as const;

const DOI = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/g;
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/gi;
const ARXIV_ID = /\barXiv:(\d{4}\.\d{4,5})(?:v\d+)?/g;
const HTTP = /https?:\/\/[^\s<>"'`)\]]+/gi;
const OWNED_HOSTS = new Set(["github.com", "doi.org", "dx.doi.org", "arxiv.org"]);

function bump(map: Map<string, HarvestHit>, hit: Omit<HarvestHit, "n">) {
  const key = `${hit.topic}\n${hit.value.toLowerCase()}`;
  const prev = map.get(key);
  if (prev) prev.n += 1;
  else map.set(key, { ...hit, n: 1 });
}

function trimTail(value: string) {
  return value.replace(/[).,;:]+$/g, "");
}

export function githubHits(text: string): GithubHit[] {
  const hits = new Map<string, GithubHit>();
  for (const match of text.matchAll(GITHUB)) {
    const owner = match[1]!;
    const repo = match[2]!.replace(/\.git$/, "");
    if (SKIP_REPO.has(repo.toLowerCase())) continue;
    const url = `https://github.com/${owner}/${repo}`;
    const key = url.toLowerCase();
    const prev = hits.get(key);
    if (prev) prev.n += 1;
    else hits.set(key, { url, owner, repo, n: 1 });
  }
  return [...hits.values()].sort((a, b) => b.n - a.n || a.url.localeCompare(b.url));
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function customHits(text: string, topic: TopicDef, into: Map<string, HarvestHit>) {
  if (!topic.pattern || topic.pattern.length > 200) return;
  let re: RegExp;
  try {
    re = new RegExp(topic.pattern, "gi");
  } catch {
    return;
  }
  for (const match of text.matchAll(re)) {
    const value = trimTail(match[1] || match[0] || "");
    if (!value) continue;
    const title = trimTail(match[2] || value);
    bump(into, { topic: topic.id, category: topic.category, title, value, tags: normTags(topic.tags) });
    if (into.size > 80) return;
  }
}

export function harvestHits(text: string, custom: TopicDef[] = [], topic?: string): HarvestHit[] {
  const wanted = topic && topic !== "all" ? topic.toLowerCase() : "";
  const map = new Map<string, HarvestHit>();
  const source = text.slice(0, 200_000);
  if (!wanted || wanted === "github") {
    for (const hit of githubHits(source)) {
      bump(map, {
        topic: "github",
        category: "GitHub",
        title: `${hit.owner}/${hit.repo}`,
        value: hit.url,
        tags: ["github"],
      });
      const stored = map.get(`github\n${hit.url.toLowerCase()}`);
      if (stored) stored.n = hit.n;
    }
  }
  if (!wanted || wanted === "doi") {
    for (const match of source.matchAll(DOI)) {
      const doi = trimTail(match[1]!).replace(/\.$/, "");
      bump(map, { topic: "doi", category: "Paper", title: doi, value: `https://doi.org/${doi}`, tags: ["doi", "paper"] });
    }
  }
  if (!wanted || wanted === "arxiv") {
    const counts = new Map<string, number>();
    for (const re of [ARXIV_URL, ARXIV_ID]) {
      for (const match of source.matchAll(re)) {
        const id = match[1]!;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    for (const [id, n] of counts) {
      const value = `https://arxiv.org/abs/${id}`;
      bump(map, { topic: "arxiv", category: "Paper", title: `arXiv:${id}`, value, tags: ["arxiv", "paper"] });
      const stored = map.get(`arxiv\n${value.toLowerCase()}`);
      if (stored) stored.n = n;
    }
  }
  if (!wanted || wanted === "url") {
    for (const match of source.matchAll(HTTP)) {
      const url = trimTail(match[0]);
      const host = hostOf(url);
      if (!host || OWNED_HOSTS.has(host)) continue;
      let title = url;
      try {
        const parsed = new URL(url);
        title = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
      } catch {
        continue;
      }
      bump(map, { topic: "url", category: "Link", title, value: url, tags: ["url"] });
    }
  }
  if (!BUILTIN_TOPICS.includes(wanted as (typeof BUILTIN_TOPICS)[number])) {
    for (const def of custom) {
      if (wanted && def.id.toLowerCase() !== wanted) continue;
      customHits(source, def, map);
    }
  }
  return [...map.values()].sort((a, b) => b.n - a.n || a.topic.localeCompare(b.topic) || a.value.localeCompare(b.value));
}
