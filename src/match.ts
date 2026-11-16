import { fuzzyMatch } from "@earendil-works/pi-tui";
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
  /** Last time the item was inserted. Kept apart from `updated` so editing stays visible. */
  lastUsed?: string;
  /** Where this entry goes when several are inserted together. */
  placement?: "prepend" | "append";
  /** Tie-breaker inside one placement group; smaller goes first. */
  order?: number;
  /** Short names/acronyms used only for fuzzy lookup (eman, relion). */
  aliases?: string[];
  /** Human description shown when picking a reference. */
  description?: string;
};

export type Row = Item & { dynamic?: boolean; scope?: "global" | "project" };

export type Query = { tags: string[]; category: string; text: string; exact: string[]; not: string[] };

/** fzf-style operators, so a common word can be narrowed without a regex. */
const PREFIX = "^";
const SUFFIX = "$";
const NEGATE = "!";
const EXACT = "'";

const GITHUB = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\/\s)"'`,;:]|$)/gi;
const SKIP_REPO = new Set(["pull", "pulls", "issues", "blob", "tree", "commit", "commits", "actions", "releases"]);

export function normTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))];
}

export function parseQuery(raw: string): Query {
  const tags: string[] = [];
  const exact: string[] = [];
  const not: string[] = [];
  let category = "";
  const words: string[] = [];
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    // @category and #tag win over the operators: a tag may legitimately start with !
    // or contain $, and the shelf's own syntax must stay predictable.
    if (part.startsWith("#") && part.length > 1) {
      tags.push(part.slice(1).toLowerCase());
      continue;
    }
    if (part.startsWith("@") && part.length > 1) {
      category = part.slice(1).toLowerCase();
      continue;
    }
    const negated = part.startsWith(NEGATE) && part.length > 1;
    const body = negated ? part.slice(1) : part;
    const quoted = body.startsWith(EXACT) && body.length > 1;
    const operator = !quoted && body.length > 1 && (body.startsWith(PREFIX) || body.endsWith(SUFFIX));
    const term = (quoted ? body.slice(1) : body).toLowerCase();
    if (!term) continue;
    if (negated) not.push(term);
    else if (quoted || operator) exact.push(term);
    else words.push(term);
  }
  return { tags, category, text: words.join(" "), exact, not };
}

/**
 * fzf's remaining operators. A prefix binds to the start, a suffix to the end, and a bare
 * term matches anywhere; all of them are case-insensitive substring tests rather than
 * fuzzy matches, because that is what the operator promises.
 */
function termHit(hay: string, term: string) {
  if (term.startsWith(PREFIX)) return hay.startsWith(term.slice(1));
  if (term.endsWith(SUFFIX)) return hay.endsWith(term.slice(0, -1));
  return hay.includes(term);
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

export type SlashCommandContext = { name: string; args: string; bare: boolean };

export function slashCommandContext(text: string): SlashCommandContext | null {
  const match = text.match(/^\s*\/([A-Za-z0-9_-]+)(?:\s+(.*?))?\s*$/);
  if (!match) return null;
  return { name: match[1]!, args: match[2] ?? "", bare: match[2] === undefined };
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

export type ShelfCompletionContext = { kind: "action" | "topic" | "prompt"; prefix: string; bare: boolean };

export function shelfCompletionContext(text: string): ShelfCompletionContext | null {
  const topic = text.match(/^\s*\/shelf\s+harvest\s+(\S*)\s*$/i);
  if (topic) return { kind: "topic", prefix: topic[1] ?? "", bare: false };
  const prompt = text.match(/^\s*\/shelf\s+prompt\s+(\S*)\s*$/i);
  if (prompt) return { kind: "prompt", prefix: prompt[1] ?? "", bare: false };
  const action = text.match(/^\s*\/shelf(?:\s+(\S*))?\s*$/i);
  if (!action) return null;
  return { kind: "action", prefix: action[1] ?? "", bare: text.trim().toLowerCase() === "/shelf" };
}

export type ShelfQueryContext = { seed: string; explicit: boolean };

export function shelfQueryContext(text: string, forced: boolean): ShelfQueryContext | null {
  if (slashCommandContext(text) || pathToken(text)) return null;
  const seed = draftSeed(text);
  if (seed.length < 2) return null;
  const explicit = seed.startsWith("@") || seed.startsWith("#");
  if (!explicit && /[@#]/.test(seed)) return null;
  if (!forced && !explicit) return null;
  return { seed, explicit };
}

export type ShelfInterceptionContext =
  | { kind: "shelf-command"; context: ShelfCompletionContext }
  | { kind: "add-dir-path"; path: string }
  | { kind: "foreign-slash"; context: SlashCommandContext }
  | { kind: "shelf-query"; query: ShelfQueryContext }
  | { kind: "native" };

export function shelfInterceptionContext(text: string, forced: boolean): ShelfInterceptionContext {
  const shelf = shelfCompletionContext(text);
  if (shelf) return { kind: "shelf-command", context: shelf };
  const addDirPath = addDirArgument(text);
  const slash = slashCommandContext(text);
  if (slash && slash.name !== "add-dir") return { kind: "foreign-slash", context: slash };
  // A bare /add-dir word stays Pi's until Tab explicitly asks for a fuzzy directory match.
  if (addDirPath !== null && (isPathLikeToken(addDirPath) || forced)) return { kind: "add-dir-path", path: addDirPath };
  if (slash) return { kind: "foreign-slash", context: slash };
  const query = shelfQueryContext(text, forced);
  if (query) return { kind: "shelf-query", query };
  return { kind: "native" };
}

/**
 * Whether a row is a prompt template. Positional syntax alone is not evidence: a saved
 * shell command such as `awk '{print $1}'` contains $1 but must insert verbatim. The
 * category, the prompt-file id, or an explicit {{slot}} is the signal.
 */
export function isPromptRow(row: Pick<Row, "id" | "category" | "value">) {
  return (
    row.id.startsWith("prompt-file:") ||
    row.category.toLowerCase() === "prompt" ||
    templateSlots(row.value).length > 0
  );
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

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shelfMatches(rows: Row[], token: string, forced = false) {
  const queryText = token.trim();
  if (!forced && queryText.length < 2 && !queryText.startsWith("@") && !queryText.startsWith("#")) return [];
  return rankRows(rows, queryText, 8);
}

export function rankPath(path: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return 4;
  // Tolerate a trailing separator so a directory path still ranks by its own name.
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = normalized.split("/").pop() ?? normalized;
  return Math.min(fuzzy(base, q), fuzzy(normalized, q) + 1);
}

/**
 * Field tiers keep a title hit ahead of a value hit, and the gap (3) is wider than the
 * normalized quality range (2) so a long URL that happens to contain the query can never
 * outrank the item whose title is the query. Pi's fuzzyMatch scores word boundaries,
 * consecutive runs and exact equality, which the old four-level check could not.
 */
const FIELD_TIER = { title: 0, alias: 1.5, tags: 3, description: 4.5, value: 6, category: 9 } as const;
const QUALITY_MAX = 200;

function fieldQuality(text: string, token: string, literalForShort = false) {
  const body = text ?? "";
  // A long prompt body contains almost any three-letter subsequence ("zzz" hides in
  // summarizer/analyzes/zero). Short tokens therefore need a literal substring in the
  // body; longer ones keep the fuzzy ranking.
  if (literalForShort && token.length <= 4 && !body.toLowerCase().includes(token.toLowerCase())) return Infinity;
  const match = fuzzyMatch(token, body);
  if (!match.matches) return Infinity;
  return Math.max(-1, Math.min(1, match.score / QUALITY_MAX));
}

export function score(row: Pick<Row, "category" | "title" | "value" | "tags" | "aliases" | "description">, query: Query) {
  if (query.category && fuzzy(row.category, query.category) === Infinity) return Infinity;
  const tags = normTags(row.tags);
  const aliases = (row.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
  if (query.tags.some((tag) => !tags.includes(tag))) return Infinity;
  // Operators are per field: a suffix must not be defeated by the field that happens to
  // be concatenated after it.
  const fields = [row.title ?? "", aliases.join(" "), tags.join(" "), row.description ?? "", row.value ?? "", row.category ?? ""].map((field) => field.toLowerCase());
  const termFound = (term: string) => fields.some((field) => termHit(field, term));
  if (query.not.some((term) => termFound(term))) return Infinity;
  if (query.exact.some((term) => !termFound(term))) return Infinity;
  if (!query.text) {
    // Operator-only queries still order title hits above body hits; otherwise the result
    // is alphabetical and "notes" overtakes the entry actually named after the term.
    if (!query.exact.length) return 4;
    const title = (row.title ?? "").toLowerCase();
    return query.exact.every((term) => termHit(title, term)) ? 3 : 4;
  }
  const tokens = query.text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 4;
  let total = 0;
  for (const token of tokens) {
    // Every token has to land somewhere; a row that only matches one of two words is not
    // a weaker match, it is not a match.
    const best = Math.min(
      fieldQuality(row.title, token) + FIELD_TIER.title,
      fieldQuality(aliases.join(" "), token) + FIELD_TIER.alias,
      fieldQuality(tags.join(" "), token) + FIELD_TIER.tags,
      fieldQuality(row.description ?? "", token) + FIELD_TIER.description,
      fieldQuality(row.value, token, true) + FIELD_TIER.value,
      fieldQuality(row.category, token) + FIELD_TIER.category,
    );
    if (best === Infinity) return Infinity;
    total += best;
  }
  return total;
}

/**
 * Frecency: usage decayed with a 30-day constant. Something used ten times last year
 * should not outrank something used twice this week.
 */
export function frecency(uses: number, lastUsed: string | undefined, now = Date.now()) {
  if (!uses || uses < 0) return 0;
  const seen = Date.parse(lastUsed ?? "");
  const ageDays = Number.isFinite(seen) ? Math.max(0, (now - seen) / 86_400_000) : 30;
  return uses * Math.exp(-ageDays / 30);
}

/** Score, filter and order rows the same way the picker and the Tab completion do. */
export function rankRows<T extends Row>(rows: T[], raw: string, limit = 200, now = Date.now()) {
  const query = parseQuery(raw);
  return rows
    .map((row) => ({ row, rank: score(row, query) }))
    .filter((hit) => hit.rank !== Infinity)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        frecency(b.row.uses, b.row.lastUsed ?? b.row.updated, now) - frecency(a.row.uses, a.row.lastUsed ?? a.row.updated, now) ||
        timestamp(b.row.lastUsed ?? b.row.updated) - timestamp(a.row.lastUsed ?? a.row.updated) ||
        a.row.title.localeCompare(b.row.title),
    )
    .slice(0, limit);
}

// Pi renders each option as its own line and wraps rather than clipping, so the whole
// label has to fit one row. On an 80-column terminal 76 characters is where wrapping
// starts, and the selected option is prefixed with "→ ", so leave room for both.
const LABEL_MAX = 74;
const LABEL_TITLE_MAX = 40;

/** Selector options are one line each, so a multi-line value must not reach the renderer. */
function oneLine(text: string) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Terminal columns, not code units: a CJK glyph occupies two of them. */
function cellWidth(text: string) {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

function clip(text: string, max: number) {
  if (cellWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const step = cellWidth(ch);
    // Leave one column for the ellipsis so the clipped line still fits.
    if (width + step > max - 1) break;
    out += ch;
    width += step;
  }
  return out + "…";
}

/**
 * Display text for a selector option. Pi renders every option as its own line, so the
 * value is collapsed and clipped: a full multi-line template would otherwise expand one
 * option into a block and push the rest of the list off screen.
 */
export function label(row: Row) {
  const tags = row.tags?.length ? " #" + row.tags.join(" #") : "";
  const lines = (row.value ?? "").split("\n").length;
  const marks = [
    row.dynamic ? " ·dyn" : "",
    row.scope === "project" ? " ·repo" : "",
    templateSlots(row.value).length ? " ·tpl" : "",
    lines > 1 ? ` ·${lines}行` : "",
    row.placement === "prepend" ? " ·前" : row.placement === "append" ? " ·后" : "",
    row.description ? ` ·${clip(oneLine(row.description), 28)}` : "",
  ].join("");
  const head = `@${row.category ?? ""}  ${clip(oneLine(row.title), LABEL_TITLE_MAX)}${tags}${marks}  →  `;
  // Give the value whatever room is left, then clip the whole line so a long category or
  // tag list cannot push the option past one row either. Widths are terminal columns.
  return clip(head + clip(oneLine(row.value), Math.max(12, LABEL_MAX - cellWidth(head))), LABEL_MAX);
}

/**
 * Pi's ui.select answers with the chosen string, so each option has to map back to exactly
 * one item. Labels are display text and can repeat or be clipped, so make the options
 * unique and resolve the answer by position instead of by string equality.
 */
export function choices<T>(items: T[], render: (item: T) => string) {
  const seen = new Map<string, number>();
  const options = items.map((item) => {
    const base = render(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}  (${count})`;
  });
  return {
    options,
    pick(choice: string | undefined) {
      const index = choice === undefined ? -1 : options.indexOf(choice);
      return index < 0 ? undefined : items[index];
    },
  };
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
    // A sentence-ending period is part of the match, not the repository name.
    const repo = trimTail(match[2]!).replace(/\.git$/, "");
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
