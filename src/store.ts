import type { Item, TopicDef } from "./match.ts";

export type Scope = "global" | "project";
export type DynamicSource = { id: string; category: string; tags: string[]; command: string };
export type Collection = { version: 2; items: Item[]; archive: Item[] };
export type Rules = { version: 1; topics: TopicDef[]; sources: DynamicSource[] };
export type ProjectShelf = {
  version: 1;
  remote: string;
  items: Item[];
  archive: Item[];
  topics: TopicDef[];
  sources: DynamicSource[];
};
export type ScopedItem = Item & { scope: Scope };
export type ShellCall = { command: string; args: string[] };

export function shellPlan(platformName: string, command: string): ShellCall[] {
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
    return body ? [{ command: commandName, args: [...args, body] }] : [];
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
  return { version: 1, topics: [], sources: [] };
}

export function emptyProject(remote = ""): ProjectShelf {
  return { version: 1, remote, items: [], archive: [], topics: [], sources: [] };
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

export function splitLegacy(raw: { version?: number; items?: Item[]; archive?: Item[]; topics?: TopicDef[]; sources?: DynamicSource[] }) {
  const collection: Collection = {
    version: 2,
    items: Array.isArray(raw.items) ? raw.items : [],
    archive: Array.isArray(raw.archive) ? raw.archive : [],
  };
  const rules: Rules = {
    version: 1,
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    sources: Array.isArray(raw.sources) ? raw.sources : [],
  };
  const strip = Array.isArray(raw.topics) || Array.isArray(raw.sources) || raw.version !== 2;
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
  return { version: 1, topics, sources };
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
