import type { Row } from "./match.ts";

export type UrlKind = "github" | "doi" | "arxiv" | "url" | "path";

export type ParsedTarget = {
  kind: UrlKind;
  /** What gets inserted: always the canonical, exact string. */
  value: string;
  /** Short human handle: owner/repo, DOI suffix, file stem. */
  label: string;
  /** Extra lookup words derived from the target itself. */
  aliases: string[];
};

const GITHUB = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/[^?\s#]*)?(?:[?#].*)?$/i;
const SHORT_GITHUB = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;
const ARXIV = /^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\/)?$/i;
const HTTP_URL = /^https?:\/\/\S+$/i;
const PATH = /^(?:[A-Za-z]:[\\/]|~[\\/]|\/[^/]|\.\.?[\\/])/;

function words(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

/**
 * Turn whatever the user pasted into one exact target plus lookup words. Repository URLs
 * are canonicalized to https://github.com/owner/repo because that is the form the GitHub
 * MCP server and the API accept; a trailing .git, a /tree/... path or a bare owner/repo
 * would all fail to resolve there.
 */
export function parseTarget(raw: string): ParsedTarget | null {
  const text = raw.trim();
  if (!text) return null;
  const github = text.match(GITHUB);
  if (github) {
    const owner = github[1]!;
    const repo = github[2]!.replace(/\.git$/i, "");
    return {
      kind: "github",
      value: `https://github.com/${owner}/${repo}`,
      label: `${owner}/${repo}`,
      aliases: [repo, owner, `${owner}/${repo}`, ...words(repo), ...words(owner)],
    };
  }
  const doi = text.match(DOI);
  if (doi) {
    const suffix = doi[1]!;
    return {
      kind: "doi",
      value: `https://doi.org/${suffix}`,
      label: suffix,
      aliases: [suffix, ...words(suffix)],
    };
  }
  const arxiv = text.match(ARXIV);
  if (arxiv) {
    const id = arxiv[1]!;
    return { kind: "arxiv", value: `https://arxiv.org/abs/${id}`, label: id, aliases: [id] };
  }
  const shortGithub = text.match(SHORT_GITHUB);
  if (shortGithub) {
    const owner = shortGithub[1]!;
    const repo = shortGithub[2]!.replace(/\.git$/i, "");
    return {
      kind: "github",
      value: `https://github.com/${owner}/${repo}`,
      label: `${owner}/${repo}`,
      aliases: [repo, owner, `${owner}/${repo}`, ...words(repo), ...words(owner)],
    };
  }
  if (HTTP_URL.test(text)) {
    let host = "";
    let path = "";
    try {
      const parsed = new URL(text);
      host = parsed.hostname.replace(/^www\./, "");
      path = parsed.pathname;
    } catch {
      // keep the raw string; the URL constructor is only used for aliases
    }
    return { kind: "url", value: text, label: host || text.slice(0, 40), aliases: [host, ...words(host), ...words(path)].filter(Boolean) };
  }
  if (PATH.test(text)) {
    const base = text.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? text;
    return { kind: "path", value: text, label: base, aliases: [base, ...words(base)] };
  }
  return null;
}

export type ResolveMatch = { row: Row; score: number; exact: boolean };

/** Exact target first, then a row whose alias is the query, then ranked fuzzy hits. */
export function rankTargets(rows: Row[], query: string, ranked: Row[]): ResolveMatch[] {
  const needle = query.trim().toLowerCase();
  const scored: ResolveMatch[] = [];
  const seen = new Set<string>();
  const push = (row: Row, score: number, exact: boolean) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    scored.push({ row, score, exact });
  };
  for (const row of rows) {
    const value = (row.value ?? "").trim().toLowerCase();
    const title = (row.title ?? "").trim().toLowerCase();
    const aliases = (row.aliases ?? []).map((alias) => alias.trim().toLowerCase());
    if (needle && (value === needle || title === needle || aliases.includes(needle))) push(row, -1, true);
  }
  for (const [index, row] of ranked.entries()) push(row, index, false);
  return scored;
}
