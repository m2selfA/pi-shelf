import { randomUUID } from "node:crypto";

export type Alias = { key: string; value: string; description?: string };
export type AliasContext = {
  now?: Date;
  clipboard?: string;
  uuid?: () => string;
  random?: () => number;
};
export type ExpandedAlias = { text: string; cursorOffset?: number };

/** Shown in the add/edit dialog. Unknown macros are left untouched. */
export const ALIAS_MACROS = "{{date}} {{time}} {{datetime}} {{clipboard}} {{random:a|b}} {{cursor}}";

const MACRO = /\{\{\s*([A-Za-z]+)(?::([^{}]*))?\s*\}\}/g;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatDate(now: Date) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatTime(now: Date) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Expand the macros we deliberately support. TextExpander/Espanso established the set:
 * date, time, clipboard close a snippet; cursor places the caret; random avoids repeats.
 * Shell/script macros are intentionally absent: aliases are just text, not a command
 * execution surface. Unknown macros stay literal so a typo is visible instead of silent.
 */
export function expandAlias(value: string, context: AliasContext = {}): ExpandedAlias {
  const now = context.now ?? new Date();
  const random = context.random ?? Math.random;
  let cursorSeen = false;
  const text = value.replace(MACRO, (full, rawName: string, rawArg: string | undefined) => {
    const name = rawName.toLowerCase();
    if (name === "date") return formatDate(now);
    if (name === "time") return formatTime(now);
    if (name === "datetime") return `${formatDate(now)} ${formatTime(now)}`;
    if (name === "clipboard") return context.clipboard === undefined ? full : context.clipboard;
    if (name === "uuid") return (context.uuid ?? randomUUID)();
    if (name === "random") {
      const choices = (rawArg ?? "").split("|").map((choice) => choice.trim()).filter(Boolean);
      if (!choices.length) return full;
      return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))] ?? full;
    }
    if (name === "cursor") {
      if (cursorSeen) return "";
      cursorSeen = true;
      return "\u0000";
    }
    return full;
  });
  const marker = text.indexOf("\u0000");
  return marker >= 0 ? { text: text.replace(/\u0000/g, ""), cursorOffset: marker } : { text };
}

export function aliasKeyValid(key: string) {
  return /^[A-Za-z0-9_.:-]{2,32}$/.test(key.trim());
}

export type AliasMatch<T extends Alias> = { alias: T; rank: number };

/** Exact aliases first, then prefix hits; bare one-character prefixes are noise. */
export function matchAliases<T extends Alias>(aliases: T[], prefix: string, limit = 8): AliasMatch<T>[] {
  const query = prefix.trim().toLowerCase();
  if (query.length < 2) return [];
  return aliases
    .map((alias) => {
      const key = alias.key.toLowerCase();
      const rank = key === query ? 0 : key.startsWith(query) ? 1 : key.includes(query) ? 2 : Infinity;
      return { alias, rank };
    })
    .filter((hit) => hit.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.alias.key.length - b.alias.key.length || a.alias.key.localeCompare(b.alias.key))
    .slice(0, limit);
}
