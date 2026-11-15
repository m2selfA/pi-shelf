export type ToolLike = {
  name: string;
  description?: string;
  exposure?: string;
  namespace?: { name?: string };
  sourceInfo?: { source?: string; path?: string };
};

export type ToolToken = { prefix: string; auto: boolean };
export type ToolSuggestion = { name: string; description: string };

const TOKEN = /[A-Za-z0-9_.:-]+$/;

/**
 * The tool-name token under the cursor. Explicit Tab always asks; otherwise only a token
 * containing "_" opens on its own, because tool names are the only identifiers in prose
 * that look like that (web_search, mcp__github__search_code). Bare words such as "read"
 * stay quiet until Tab, so writing normal sentences never pops a tool list.
 */
export function toolToken(text: string, forced: boolean): ToolToken | null {
  const match = text.match(TOKEN);
  if (!match) return null;
  const prefix = match[0];
  if (prefix.length < 2 || !/[A-Za-z]/.test(prefix)) return null;
  const lead = text.slice(0, text.length - prefix.length).slice(-1);
  // "/x", "@x" and "#x" are commands, attachments and tags, not tool names.
  if (lead === "/" || lead === "@" || lead === "#") return null;
  const auto = prefix.includes("_");
  if (!forced && !auto) return null;
  return { prefix, auto };
}

function rank(name: string, prefix: string) {
  const value = name.toLowerCase();
  const query = prefix.toLowerCase();
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  // A segment hit ("search" -> web_search, mcp__github__search_code) beats a random
  // substring, and both beat a scattered subsequence.
  if (value.split(/[_.:-]+/).some((segment) => segment.startsWith(query))) return 2;
  if (value.includes(query)) return 3;
  let cursor = 0;
  for (const char of value) if (char === query[cursor]) cursor += 1;
  return cursor === query.length ? 4 : Infinity;
}

function firstLine(text: string | undefined, max = 70) {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function sourceLabel(tool: ToolLike) {
  const namespace = tool.namespace?.name ?? "";
  if (namespace.startsWith("mcp__")) return `MCP ${namespace.slice("mcp__".length)}`;
  if (tool.sourceInfo?.source === "builtin") return "内置";
  if (tool.sourceInfo?.source === "sdk") return "SDK";
  return "扩展";
}

export function describeTool(tool: ToolLike, active: boolean) {
  const state = active ? "" : tool.exposure === "codemode" || tool.exposure === "deferred" ? "codemode" : "未启用";
  return [sourceLabel(tool), state, firstLine(tool.description)].filter(Boolean).join(" · ");
}

/**
 * Rank tools by how well their name matches the typed token. Active tools win ties: the
 * model can call those right now, while a hidden or inactive tool is still worth
 * completing for prompts and instructions.
 */
export function rankTools(tools: ToolLike[], prefix: string, active: Iterable<string> = [], limit = 8): ToolSuggestion[] {
  const activeSet = new Set(active);
  return tools
    .filter((tool) => Boolean(tool.name) && tool.exposure !== "hidden")
    .map((tool) => ({ tool, rank: rank(tool.name, prefix) }))
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
