import { createHash } from "node:crypto";
import type { Item, TopicDef } from "./match.ts";

export type Scope = "global" | "project";
export type DynamicSource = { id: string; category: string; tags: string[]; command: string };
/** A named command whose stdout lines become candidates for a {{name=@id}} slot. */
export type ValueProvider = { id: string; command: string; label?: string };
/** A user-defined abbreviation: typing the key + Tab expands to value. */
export type Alias = { key: string; value: string; description?: string };
export type Collection = { version: 2; items: Item[]; archive: Item[] };
export type Rules = { version: 1; topics: TopicDef[]; sources: DynamicSource[]; values: ValueProvider[]; aliases: Alias[] };
export type ProjectShelf = {
  version: 1;
  remote: string;
  items: Item[];
  archive: Item[];
  topics: TopicDef[];
  sources: DynamicSource[];
  values: ValueProvider[];
};
export type ScopedItem = Item & { scope: Scope };
export type ShellCall = { command: string; args: string[] };

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function shellPlan(platformName: string, command: string, cwd = ""): ShellCall[] {
  const text = command.trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  const tagged: Array<[string, string, string[]]> = [
    ["powershell:", "powershell.exe", ["-NoProfile", "-Command"]],
    ["pwsh:", "pwsh", ["-NoProfile", "-Command"]],
    ["cmd:", "cmd.exe", ["/d", "/s", "/c"]],
    ["bash:", "bash", ["-lc"]],
  ];
  for (const [prefix, commandName, args] of tagged) {
    if (!lower.startsWith(prefix)) continue;
    const body = text.slice(prefix.length).trim();
    if (!body) return [];
    // A login shell resets the working directory (Git Bash profiles cd to $HOME), so the
    // caller's cwd has to be restored before the command runs or relative paths miss.
    const script = prefix === "bash:" && cwd ? `cd -- ${shellQuote(cwd)} && ${body}` : body;
    return [{ command: commandName, args: [...args, script] }];
  }
  if (platformName === "win32") {
    return [
      { command: "powershell.exe", args: ["-NoProfile", "-Command", text] },
      { command: "cmd.exe", args: ["/d", "/s", "/c", text] },
    ];
  }
  return [{ command: "bash", args: ["-lc", text] }];
}

export function emptyCollection(): Collection {
  return { version: 2, items: [], archive: [] };
}

export function emptyRules(): Rules {
  return { version: 1, topics: [], sources: [], values: [], aliases: [] };
}

export function emptyProject(remote = ""): ProjectShelf {
  return { version: 1, remote, items: [], archive: [], topics: [], sources: [], values: [] };
}

export function normalizeRemote(url: string) {
  let text = url.trim();
  if (text.toLowerCase().endsWith(".git")) text = text.slice(0, -4);
  if (text.startsWith("git@")) {
    const colon = text.indexOf(":");
    if (colon > 4) return stripSlash(`${text.slice(4, colon)}/${text.slice(colon + 1)}`);
  }
  if (text.startsWith("ssh://")) {
    const body = text.slice("ssh://".length).replace(/^[^@]+@/, "");
    const slash = body.indexOf("/");
    if (slash > 0) return stripSlash(`${body.slice(0, slash)}/${body.slice(slash + 1)}`);
  }
  if (text.includes("://")) {
    try {
      const parsed = new URL(text);
      const path = stripSlash(parsed.pathname.replace(/^\/+/, ""));
      return path ? `${parsed.hostname}/${path}` : parsed.hostname;
    } catch {
      return stripSlash(text);
    }
  }
  return stripSlash(text);
}

function stripSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function projectFileUsable(fileRemote: string, currentRemote: string) {
  if (!fileRemote || !currentRemote) return true;
  return normalizeRemote(fileRemote) === normalizeRemote(currentRemote);
}

export function splitLegacy(raw: { version?: number; items?: Item[]; archive?: Item[]; topics?: TopicDef[]; sources?: DynamicSource[]; values?: ValueProvider[]; aliases?: Alias[] }) {
  const collection: Collection = {
    version: 2,
    items: Array.isArray(raw.items) ? raw.items : [],
    archive: Array.isArray(raw.archive) ? raw.archive : [],
  };
  const rules: Rules = {
    version: 1,
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    values: Array.isArray(raw.values) ? raw.values : [],
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
  };
  const strip = Array.isArray(raw.topics) || Array.isArray(raw.sources) || Array.isArray(raw.values) || Array.isArray(raw.aliases) || raw.version !== 2;
  return { collection, rules, strip };
}

export function mergeItems(globalItems: Item[], projectItems: Item[]): ScopedItem[] {
  const covered = new Set(projectItems.map((item) => item.value.trim().toLowerCase()));
  const global = globalItems
    .filter((item) => !covered.has(item.value.trim().toLowerCase()))
    .map((item) => ({ ...item, scope: "global" as const }));
  return [...projectItems.map((item) => ({ ...item, scope: "project" as const })), ...global];
}

export function mergeRules(global: Rules, project: Rules): Rules {
  const topics = [...global.topics];
  for (const topic of project.topics) {
    const index = topics.findIndex((item) => item.id.toLowerCase() === topic.id.toLowerCase());
    if (index >= 0) topics[index] = topic;
    else topics.push(topic);
  }
  const sources = [...global.sources];
  for (const source of project.sources) {
    const index = sources.findIndex((item) => item.id === source.id);
    if (index >= 0) sources[index] = source;
    else sources.push(source);
  }
  const values = [...global.values];
  for (const value of project.values) {
    const index = values.findIndex((item) => item.id.toLowerCase() === value.id.toLowerCase());
    if (index >= 0) values[index] = value;
    else values.push(value);
  }
  const aliases = [...global.aliases];
  for (const alias of project.aliases) {
    const index = aliases.findIndex((item) => item.key.toLowerCase() === alias.key.toLowerCase());
    if (index >= 0) aliases[index] = alias;
    else aliases.push(alias);
  }
  return { version: 1, topics, sources, values, aliases };
}

/**
 * Three-way-safe merge used by every save: the file on disk may have been changed by
 * another Pi window between our read and our write, so writes re-read it under the lock
 * and union by id instead of replacing the file with our stale snapshot.
 *
 * Deletion is not a tombstone here: an item archived in memory is excluded from the disk
 * copy, which keeps the common "delete in one window" case correct.
 */
export function mergeCollection(disk: Collection, memory: Collection): Collection {
  const archived = new Set(memory.archive.map((item) => item.id));
  // Missing or malformed timestamps compare as 0: NaN would make every comparison false
  // and silently keep the stale disk copy.
  const stamp = (value: string | undefined) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const byId = new Map<string, Item>();
  for (const item of disk.items) if (!archived.has(item.id)) byId.set(item.id, item);
  for (const item of memory.items) {
    const previous = byId.get(item.id);
    // Prefer whichever copy was edited last; the memory copy wins a tie.
    if (!previous || stamp(item.updated) >= stamp(previous.updated)) byId.set(item.id, item);
  }
  const archive = new Map<string, Item>();
  for (const item of disk.archive) archive.set(item.id, item);
  for (const item of memory.archive) archive.set(item.id, item);
  return { version: 2, items: [...byId.values()], archive: [...archive.values()] };
}

export function mergeProject(disk: ProjectShelf, memory: ProjectShelf): ProjectShelf {
  const collection = mergeCollection(
    { version: 2, items: disk.items, archive: disk.archive },
    { version: 2, items: memory.items, archive: memory.archive },
  );
  return {
    version: 1,
    remote: memory.remote || disk.remote,
    items: collection.items,
    archive: collection.archive,
    // Rules are small and authored in one place; the memory copy is the newer one.
    topics: memory.topics,
    sources: memory.sources,
    values: memory.values,
  };
}

export function hashText(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type TrustState = "first-seen" | "approved" | "changed";

/** TOFU: the first hash is recorded, and only a later change needs a human decision. */
export function trustState(approved: string | undefined, current: string): TrustState {
  if (!approved) return "first-seen";
  return approved === current ? "approved" : "changed";
}

export function archiveItem(bag: { items: Item[]; archive: Item[] }, id: string, when: string) {
  const item = bag.items.find((entry) => entry.id === id);
  if (!item) return;
  bag.items = bag.items.filter((entry) => entry.id !== id);
  bag.archive = [{ ...item, updated: when }, ...bag.archive.filter((entry) => entry.id !== id)];
  return item;
}

export function restoreItem(bag: { items: Item[]; archive: Item[] }, id: string, when: string) {
  const item = bag.archive.find((entry) => entry.id === id);
  if (!item) return;
  bag.archive = bag.archive.filter((entry) => entry.id !== id);
  const next = { ...item, updated: when };
  const existing = bag.items.findIndex((entry) => entry.id === id || entry.value.trim().toLowerCase() === item.value.trim().toLowerCase());
  if (existing >= 0) bag.items[existing] = next;
  else bag.items.push(next);
  return next;
}
