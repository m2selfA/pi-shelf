import { frecency } from "./match.ts";

export type CompletionStat = { uses: number; lastUsed: string };
export type CompletionStats = {
  version: 1;
  /** Key is the normalized prefix stem: web-/web_/web__ all share "web". */
  tokens: Record<string, Record<string, CompletionStat>>;
};

export function emptyCompletionStats(): CompletionStats {
  return { version: 1, tokens: {} };
}

/**
 * "web-", "web_", "web__" and "web" all map to "web", so a choice made through any
 * spelling of the same stem boosts the others.
 */
export function completionKey(prefix: string) {
  return prefix.toLowerCase().replace(/[-_]+/g, "_").replace(/_+$/, "");
}

export function parseCompletionStats(raw: unknown): CompletionStats {
  const stats = emptyCompletionStats();
  if (!raw || typeof raw !== "object") return stats;
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return stats;
  for (const [key, group] of Object.entries(tokens as Record<string, unknown>)) {
    if (!key || !group || typeof group !== "object" || Array.isArray(group)) continue;
    const clean: Record<string, CompletionStat> = {};
    for (const [value, stat] of Object.entries(group as Record<string, unknown>)) {
      if (!value || !stat || typeof stat !== "object" || Array.isArray(stat)) continue;
      const uses = Number((stat as { uses?: unknown }).uses);
      const lastUsed = String((stat as { lastUsed?: unknown }).lastUsed ?? "");
      if (!Number.isFinite(uses) || uses <= 0 || !lastUsed) continue;
      clean[value] = { uses: Math.floor(uses), lastUsed };
    }
    if (Object.keys(clean).length) stats.tokens[key] = clean;
  }
  return stats;
}

export function recordCompletion(stats: CompletionStats, prefix: string, value: string, now = Date.now()) {
  const key = completionKey(prefix);
  if (!key || !value) return;
  const group = stats.tokens[key] ?? (stats.tokens[key] = {});
  const previous = group[value];
  group[value] = { uses: (previous?.uses ?? 0) + 1, lastUsed: new Date(now).toISOString() };
  // Keep the file small: a prefix remembers at most its 20 most recently used values,
  // and the whole file at most 200 prefixes.
  const entries = Object.entries(group);
  if (entries.length > 20) {
    entries.sort((a, b) => Date.parse(b[1].lastUsed) - Date.parse(a[1].lastUsed));
    stats.tokens[key] = Object.fromEntries(entries.slice(0, 20));
  }
  const keys = Object.keys(stats.tokens);
  if (keys.length > 200) {
    keys.sort((a, b) => latestUse(stats.tokens[b]!) - latestUse(stats.tokens[a]!));
    for (const stale of keys.slice(200)) delete stats.tokens[stale];
  }
}

function latestUse(group: Record<string, CompletionStat>) {
  return Math.max(0, ...Object.values(group).map((stat) => Date.parse(stat.lastUsed) || 0));
}

/** Score per candidate for the current prefix; higher is better. */
export function completionScores(stats: CompletionStats, prefix: string, now = Date.now()) {
  const scores = new Map<string, number>();
  const group = stats.tokens[completionKey(prefix)] ?? {};
  for (const [value, stat] of Object.entries(group)) {
    scores.set(value, frecency(stat.uses, stat.lastUsed, now));
  }
  return scores;
}
