import { readdir } from "node:fs/promises";

export type RemoteToken = {
  prefix: string;
  destination: string;
  listDir: string;
  namePrefix: string;
  displayDir: string;
};

export type LocalPathToken = {
  prefix: string;
  directory: string;
  namePrefix: string;
};

export type LocalPathEntry = { name: string; dir: boolean };

export type CompletionFilter = { directoriesOnly?: boolean; fuzzy?: boolean };

export type SshHosts = { hosts: string[]; patterns: string[] };

function completionRank(name: string, prefix: string, fuzzy: boolean) {
  const query = prefix.toLowerCase();
  if (!query) return 0;
  const value = name.toLowerCase();
  if (!fuzzy) return value.startsWith(query) ? 0 : Infinity;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.includes(query)) return 2;
  let cursor = 0;
  for (const char of value) if (char === query[cursor]) cursor += 1;
  return cursor === query.length ? 3 : Infinity;
}

function visiblePathName(name: string, prefix: string) {
  return !name.startsWith(".") || prefix.startsWith(".");
}

function naturalNameCompare(left: string, right: string) {
  const a = left.toLowerCase().match(/\d+|\D+/g) ?? [left.toLowerCase()];
  const b = right.toLowerCase().match(/\d+|\D+/g) ?? [right.toLowerCase()];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const aPart = a[i]!;
    const bPart = b[i]!;
    if (/^\d+$/.test(aPart) && /^\d+$/.test(bPart)) {
      const difference = Number(aPart) - Number(bPart);
      if (difference) return difference;
    } else if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return a.length - b.length;
}

function comparePathEntries(a: { name: string; dir: boolean; rank: number }, b: { name: string; dir: boolean; rank: number }) {
  return a.rank - b.rank || Number(b.dir) - Number(a.dir) || naturalNameCompare(a.name, b.name);
}

export function parseLocalDrivePath(text: string): LocalPathToken | null {
  const normalized = text.replaceAll("\\", "/");
  if (!/^[A-Za-z]:\//.test(normalized)) return null;
  const slash = normalized.lastIndexOf("/");
  return { prefix: text, directory: normalized.slice(0, slash + 1), namePrefix: normalized.slice(slash + 1) };
}

export function localPathItems(token: LocalPathToken, entries: LocalPathEntry[], options: CompletionFilter = {}) {
  const prefix = token.namePrefix;
  return entries
    .filter((entry) => !options.directoriesOnly || entry.dir)
    .filter((entry) => visiblePathName(entry.name, prefix))
    .map((entry) => ({ entry, rank: completionRank(entry.name, prefix, options.fuzzy === true) }))
    .filter((item) => item.rank !== Infinity)
    .sort((a, b) => comparePathEntries({ ...a.entry, rank: a.rank }, { ...b.entry, rank: b.rank }))
    .map(({ entry }) => ({
      value: `${token.directory}${entry.name}${entry.dir ? "/" : ""}`,
      label: `${entry.name}${entry.dir ? "/" : ""}`,
    }));
}

export async function localDriveItems(text: string, options: CompletionFilter = {}) {
  const token = parseLocalDrivePath(text);
  if (!token) return null;
  try {
    const entries = await readdir(token.directory, { withFileTypes: true });
    return localPathItems(token, entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory() })), options);
  } catch {
    return [];
  }
}

const SCHEMES = new Set(["http", "https", "file", "ftp", "sftp", "doi", "mailto", "ssh", "git"]);
const REMOTE = /(?:^|[\s"'`(])((?:[\w.+-]+@)?(?:\[[^\]]+\]|[\w.-]+)):([^\s"'`]*)$/;

export function parseRemoteToken(textBeforeCursor: string): RemoteToken | null {
  const match = textBeforeCursor.match(REMOTE);
  if (!match) return null;
  const destination = match[1]!;
  const typed = match[2] ?? "";
  const host = destination.startsWith("[") ? destination : (destination.split("@").pop() ?? destination);
  if (SCHEMES.has(host.toLowerCase())) return null;
  if (!destination.includes("@") && /^[A-Za-z]$/.test(host)) return null;
  let listDir = ".";
  let namePrefix = typed;
  let displayDir = "";
  if (typed.endsWith("/")) {
    listDir = typed === "/" ? "/" : typed.slice(0, -1) || "/";
    namePrefix = "";
    displayDir = typed;
  } else if (typed.includes("/")) {
    const slash = typed.lastIndexOf("/");
    displayDir = typed.slice(0, slash + 1);
    listDir = displayDir === "/" ? "/" : displayDir.slice(0, -1);
    namePrefix = typed.slice(slash + 1);
  }
  return { prefix: `${destination}:${typed}`, destination, listDir, namePrefix, displayDir };
}

export function parseSshConfigHosts(config: string): SshHosts {
  const hosts: string[] = [];
  const patterns: string[] = [];
  for (const raw of config.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^Host\s+(.+)$/i);
    if (!match) continue;
    for (const name of match[1]!.split(/\s+/)) {
      if (!name || name === "*") continue;
      if (name.includes("*") || name.includes("?")) patterns.push(name);
      else hosts.push(name);
    }
  }
  return { hosts, patterns };
}

export function parseKnownHosts(text: string): SshHosts {
  const hosts: string[] = [];
  const patterns: string[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("|")) continue;
    const field = line.split(/\s+/)[0] ?? "";
    for (const name of field.split(",")) {
      if (!name || name.startsWith("|") || name.startsWith("[")) continue;
      // known_hosts can list wildcard patterns; they only match through the pattern list.
      if (name.includes("*") || name.includes("?")) patterns.push(name);
      else hosts.push(name);
    }
  }
  return { hosts, patterns };
}

function globToRegExp(pattern: string) {
  let body = "";
  for (const ch of pattern) {
    if (ch === "*") body += ".*";
    else if (ch === "?") body += ".";
    else if (".+^${}()|[]\\".includes(ch)) body += "\\" + ch;
    else body += ch;
  }
  return new RegExp("^" + body + "$", "i");
}

export function hostAllowed(destination: string, known: SshHosts): boolean {
  const host = destination.startsWith("[") ? destination : (destination.split("@").pop() ?? destination);
  if (known.hosts.some((item) => item.toLowerCase() === host.toLowerCase())) return true;
  return known.patterns.some((pattern) => globToRegExp(pattern).test(host));
}

export type RemoteEntry = { name: string; dir: boolean };

export function remoteEntries(listing: string, namePrefix: string, options: CompletionFilter = {}): RemoteEntry[] {
  const entries: Array<RemoteEntry & { rank: number }> = [];
  for (const raw of listing.split(/\n/)) {
    const line = raw.trim();
    if (!line || line === "./" || line === "../") continue;
    const dir = line.endsWith("/");
    const name = dir ? line.slice(0, -1) : line;
    if (!name || name === "." || name === "..") continue;
    if (options.directoriesOnly && !dir) continue;
    if (!visiblePathName(name, namePrefix)) continue;
    const rank = completionRank(name, namePrefix, options.fuzzy === true);
    if (rank === Infinity) continue;
    entries.push({ name, dir, rank });
  }
  return entries.sort((a, b) => comparePathEntries(a, b)).slice(0, 30).map(({ name, dir }) => ({ name, dir }));
}

export function remoteItems(token: RemoteToken, entries: RemoteEntry[]) {
  return entries.map((entry) => {
    const path = `${token.displayDir}${entry.name}${entry.dir ? "/" : ""}`;
    const value = `${token.destination}:${path}`;
    return { value, label: `${entry.name}${entry.dir ? "/" : ""}`, description: value };
  });
}

export function applyRemoteCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  value: string,
  prefix: string,
  directory: boolean,
  cursorOffset?: number,
) {
  const currentLine = lines[cursorLine] ?? "";
  const before = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
  const after = currentLine.slice(cursorCol);
  const suffix = directory ? "" : " ";
  // The editor keeps one logical line per array entry, so a value that spans
  // lines (a prompt template, for example) must be split instead of embedded.
  const head = `${before}${value}`.replace(/\r\n?/g, "\n");
  const inserted = head.split("\n");
  const last = inserted.pop() ?? "";
  const tail = `${last}${suffix}${after}`;
  // A {{cursor}} macro (or any caller-supplied offset) places the caret inside the
  // inserted text instead of after it.
  if (cursorOffset !== undefined) {
    const headToCursor = `${before}${value.slice(0, cursorOffset)}`.replace(/\r\n?/g, "\n");
    const cursorLines = headToCursor.split("\n");
    const cursorColAt = (cursorLines.pop() ?? "").length;
    return {
      lines: [...lines.slice(0, cursorLine), ...inserted, tail, ...lines.slice(cursorLine + 1)],
      cursorLine: cursorLine + cursorLines.length,
      cursorCol: cursorColAt,
    };
  }
  return {
    lines: [...lines.slice(0, cursorLine), ...inserted, tail, ...lines.slice(cursorLine + 1)],
    cursorLine: cursorLine + inserted.length,
    cursorCol: `${last}${suffix}`.length,
  };
}

export function isAltSlash(data: string) {
  const esc = String.fromCharCode(27);
  if (data === esc + "/") return true;
  if (data.startsWith(esc + "[27;") && data.endsWith("~")) {
    const parts = data.slice(esc.length + 4, -1).split(";");
    return parts.length === 2 && Number(parts[0]) - 1 === 2 && Number(parts[1]) === 47;
  }
  if (data.startsWith(esc + "[") && data.endsWith("u")) {
    const body = data.slice(2, -1);
    const semi = body.lastIndexOf(";");
    if (semi < 0) return false;
    const eventAt = body.indexOf(":", semi);
    const event = eventAt >= 0 ? Number(body.slice(eventAt + 1)) : 1;
    if (event === 3) return false;
    const mod = Number(body.slice(semi + 1, eventAt >= 0 ? eventAt : undefined)) - 1;
    const code = Number(body.slice(0, semi).split(":")[0] ?? "");
    return code === 47 && mod === 2;
  }
  return false;
}
