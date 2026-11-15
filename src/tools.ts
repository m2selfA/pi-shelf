export type ToolLike = {
  name: string;
  description?: string;
  exposure?: string;
  namespace?: { name?: string };
  sourceInfo?: { source?: string; path?: string; baseDir?: string };
  /** Short package/plugin name resolved by the caller (pi-ssh-tools, search-boost). */
  packageName?: string;
  packageFullName?: string;
  /** Every spelling of the package name, including the scoped npm name. */
  packageAliases?: string[];
  packageKind?: "plugin" | "mcp";
};

export type ToolToken = { prefix: string; auto: boolean };
export type ToolSuggestion = { name: string; description: string };
export type PackageSuggestion = {
  name: string;
  fullName?: string;
  description: string;
  toolCount: number;
};

const TOKEN = /[A-Za-z0-9_.:-]+$/;

/**
 * The tool-name token under the cursor. Explicit Tab always asks; otherwise a token
 * containing "_" or starting with "pi-" opens on its own, because those are identifiers
 * in prose (web_search, mcp__github__search_code, pi-ssh-tools). Bare words such as
 * "read" stay quiet until Tab, so writing normal sentences never pops a tool list.
 */
export function toolToken(text: string, forced: boolean): ToolToken | null {
  const match = text.match(TOKEN);
  if (!match) return null;
  const prefix = match[0];
  if (prefix.length < 2 || !/[A-Za-z]/.test(prefix)) return null;
  const lead = text.slice(0, text.length - prefix.length).slice(-1);
  // "/x", "@x" and "#x" are commands, attachments and tags, not tool names.
  if (lead === "/" || lead === "@" || lead === "#") return null;
  // Plugin names (pi-ssh-tools) are as distinctive as tool names, so they open on
  // their own too. Other hyphenated prose waits for Tab.
  const auto = prefix.includes("_") || /^pi-[a-z0-9]/i.test(prefix);
  if (!forced && !auto) return null;
  return { prefix, auto };
}

function rank(name: string, prefix: string) {
  const value = name.toLowerCase();
  const query = prefix.toLowerCase();
  if (!query) return Infinity;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  // A segment hit ("search" -> web_search, "ssh" -> pi-ssh-tools) beats a random
  // substring, and both beat a scattered subsequence.
  if (value.split(/[_.:/@-]+/).some((segment) => segment.startsWith(query))) return 2;
  if (value.includes(query)) return 3;
  let cursor = 0;
  for (const char of value) if (char === query[cursor]) cursor += 1;
  return cursor === query.length ? 4 : Infinity;
}

function bestRank(values: Iterable<string>, prefix: string) {
  let best = Infinity;
  for (const value of values) best = Math.min(best, rank(value, prefix));
  return best;
}

const GENERIC_NAMES = new Set(["agent", "extensions", "extension", "src", "dist", "bundle", "lib", "index", "packages"]);

function pathBase(path: string | undefined) {
  if (!path) return "";
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(ts|js|mjs|cjs)$/i, "");
}

/** "npm:@scope/pkg@1.2.3" -> "@scope/pkg"; "git:github.com/a/b" -> "b". */
function specName(source: string | undefined) {
  const text = (source ?? "").trim();
  if (!text || text === "builtin" || text === "sdk" || text === "auto" || text === "local") return "";
  if (text.startsWith("npm:")) {
    const spec = text.slice(4);
    const at = spec.lastIndexOf("@");
    return at > 0 ? spec.slice(0, at) : spec;
  }
  if (text.startsWith("git:")) {
    const url = text.slice(4).replace(/\.git$/i, "");
    return url.split(/[\\/]/).filter(Boolean).pop() ?? "";
  }
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/") || text.startsWith("~")) {
    return text.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  }
  return "";
}

/**
 * Best-effort package identity for a tool. sourceInfo.source is the most reliable
 * signal: Pi stores "npm:@scope/pkg", the package path for a local package, or "auto"
 * for a single-file extension. When source is not a package, fall back to the entry file
 * name ("search-boost.js" -> "search-boost") instead of the generic folder ("extensions").
 */
export function packageIdentity(
  source: string | undefined,
  path: string | undefined,
  manifestName?: string,
): { name: string; fullName: string; aliases: string[] } | null {
  if (source === "builtin" || source === "sdk") return null;
  const candidates = [manifestName, specName(source), pathBase(path)].filter(
    (value): value is string => typeof value === "string" && value.length > 0 && !GENERIC_NAMES.has(value.toLowerCase()),
  );
  const fullName = candidates[0] ?? "";
  if (!fullName) return null;
  const name = fullName.includes("/") ? fullName.slice(fullName.lastIndexOf("/") + 1) : fullName;
  const aliases = [...new Set([fullName, name].filter(Boolean))];
  return { name, fullName, aliases };
}

function firstLine(text: string | undefined, max = 70) {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function sourceLabel(tool: ToolLike) {
  const namespace = tool.namespace?.name ?? "";
  if (tool.packageKind === "mcp" || namespace.startsWith("mcp__")) return `MCP ${namespace.slice("mcp__".length)}`;
  if (tool.sourceInfo?.source === "builtin") return "内置";
  if (tool.sourceInfo?.source === "sdk") return "SDK";
  if (tool.packageName) return tool.packageName;
  return "扩展";
}

export function describeTool(tool: ToolLike, active: boolean) {
  const state = active ? "" : tool.exposure === "codemode" || tool.exposure === "deferred" ? "codemode" : "未启用";
  return [sourceLabel(tool), state, firstLine(tool.description)].filter(Boolean).join(" · ");
}

/**
 * Rank tools by name, then by their plugin/package alias. A plugin hit ranks below a real
 * tool-name hit, so typing "ssh" prefers ssh_* names while "pi-ssh-tools" still finds all
 * of that plugin's tools. Active tools win ties.
 */
export function rankTools(tools: ToolLike[], prefix: string, active: Iterable<string> = [], limit = 10): ToolSuggestion[] {
  const activeSet = new Set(active);
  return tools
    .filter((tool) => Boolean(tool.name) && tool.exposure !== "hidden")
    .map((tool) => {
      const nameRank = rank(tool.name, prefix);
      const aliasRank = bestRank(tool.packageAliases ?? [], prefix);
      // Subsequence alias hits ("ssh" inside pi-session-hub) are noise; only exact,
      // prefix, segment and substring package hits count.
      const aliasScore = aliasRank <= 3 ? aliasRank + 2 : Infinity;
      return { tool, rank: Math.min(nameRank, aliasScore) };
    })
    .filter((hit) => hit.rank !== Infinity)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(activeSet.has(b.tool.name)) - Number(activeSet.has(a.tool.name)) ||
        a.tool.name.length - b.tool.name.length ||
        a.tool.name.localeCompare(b.tool.name),
    )
    .slice(0, limit)
    .map(({ tool }) => ({ name: tool.name, description: describeTool(tool, activeSet.has(tool.name)) }));
}

/**
 * Package rows let a plugin name be completed literally ("pi-ssh-tools") while the tool
 * rows above it answer the more common question ("which tools does it provide?").
 */
export function rankPackages(tools: ToolLike[], prefix: string, limit = 3): PackageSuggestion[] {
  const groups = new Map<string, { fullName?: string; aliases: Set<string>; tools: Set<string>; kind: "plugin" | "mcp" }>();
  for (const tool of tools) {
    if (!tool.packageName) continue;
    const group = groups.get(tool.packageName) ?? {
      fullName: tool.packageFullName,
      aliases: new Set<string>(),
      tools: new Set<string>(),
      kind: tool.packageKind ?? "plugin",
    };
    for (const alias of tool.packageAliases ?? []) group.aliases.add(alias);
    group.aliases.add(tool.packageName);
    group.tools.add(tool.name);
    groups.set(tool.packageName, group);
  }
  return [...groups.entries()]
    .map(([name, group]) => ({ name, group, rank: bestRank(group.aliases, prefix) }))
    .filter((hit) => hit.rank <= 3)
    .sort((a, b) => a.rank - b.rank || b.group.tools.size - a.group.tools.size || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, group }) => {
      const sample = [...group.tools].slice(0, 5).join(", ");
      const label = group.kind === "mcp" ? "MCP 服务器" : "插件";
      const more = group.tools.size > 5 ? "…" : "";
      return {
        name,
        fullName: group.fullName && group.fullName !== name ? group.fullName : undefined,
        description: `${label} · ${group.tools.size} 个工具 · ${sample}${more}`,
        toolCount: group.tools.size,
      };
    });
}
