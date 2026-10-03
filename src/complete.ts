export type RemoteToken = {
  prefix: string;
  destination: string;
  listDir: string;
  namePrefix: string;
  displayDir: string;
};

export type SshHosts = { hosts: string[]; patterns: string[] };

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

export function parseKnownHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("|")) continue;
    const field = line.split(/\s+/)[0] ?? "";
    for (const name of field.split(",")) {
      if (name && !name.startsWith("|") && !name.startsWith("[")) hosts.push(name);
    }
  }
  return hosts;
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

export function remoteEntries(listing: string, namePrefix: string): RemoteEntry[] {
  const prefix = namePrefix.toLowerCase();
  const entries: RemoteEntry[] = [];
  for (const raw of listing.split(/\n/)) {
    const line = raw.trim();
    if (!line || line === "./" || line === "../") continue;
    const dir = line.endsWith("/");
    const name = dir ? line.slice(0, -1) : line;
    if (!name || name === "." || name === "..") continue;
    if (prefix && !name.toLowerCase().startsWith(prefix)) continue;
    entries.push({ name, dir });
    if (entries.length >= 30) break;
  }
  return entries;
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
) {
  const currentLine = lines[cursorLine] ?? "";
  const before = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
  const after = currentLine.slice(cursorCol);
  const suffix = directory ? "" : " ";
  const next = [...lines];
  next[cursorLine] = before + value + suffix + after;
  return { lines: next, cursorLine, cursorCol: before.length + value.length + suffix.length };
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
