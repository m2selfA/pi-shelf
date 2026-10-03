import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  BUILTIN_TOPICS,
  harvestHits,
  label,
  normTags,
  parseQuery,
  draftSeed,
  isMachinePath,
  pathToken,
  quotePath,
  rankPath,
  score,
  shelfMatches,
  slashCommandToken,
  type Item,
  type Row,
  type TopicDef,
} from "./src/match.ts";
import { applyPositionals, fillTemplate, parsePromptMarkdown, sessionExcerpt, sessionFolder, splitArgs, templateSlots } from "./src/template.ts";
import {
  applyRemoteCompletion,
  hostAllowed,
  isAltSlash,
  parseKnownHosts,
  parseRemoteToken,
  parseSshConfigHosts,
  remoteEntries,
  remoteItems,
  type SshHosts,
} from "./src/complete.ts";
import {
  archiveItem,
  emptyCollection,
  emptyProject,
  emptyRules,
  mergeItems,
  mergeRules,
  normalizeRemote,
  projectFileUsable,
  restoreItem,
  shellPlan,
  splitLegacy,
  type Collection,
  type DynamicSource,
  type ProjectShelf,
  type Rules,
  type Scope,
  type ScopedItem,
} from "./src/store.ts";

const execFileAsync = promisify(execFile);
const SHELF_DIR = join(homedir(), ".pi", "agent", "pi-shelf");
const STORE = join(SHELF_DIR, "store.json");
const RULES_FILE = join(SHELF_DIR, "config.json");

type ShelfLayer = {
  collection: Collection;
  rules: Rules;
  project: ProjectShelf | null;
  projectFile: string | null;
  remote: string;
  root: string | null;
  remoteBlocked: boolean;
};

type ShelfUi = {
  notify: (message: string, level: "info" | "warning" | "error") => void;
  confirm: (message: string, defaultYes?: boolean) => Promise<boolean>;
  input: (message: string, defaultValue?: string) => Promise<string | undefined>;
  select: (message: string, options: string[]) => Promise<string | undefined>;
  pasteToEditor?: (text: string) => void;
  setEditorText?: (text: string) => void;
  getEditorText?: () => string;
};

type ShelfCtx = { ui: ShelfUi; cwd?: string; sessionManager?: { getEntries?: () => unknown[] } };

function now() {
  return new Date().toISOString();
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
}

async function writeAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

async function gitText(cwd: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readRules(): Promise<Rules> {
  try {
    const parsed = JSON.parse(await readFile(RULES_FILE, "utf8")) as Rules;
    return {
      version: 1,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    };
  } catch {
    return emptyRules();
  }
}

async function loadCollection(): Promise<Collection> {
  let raw: Parameters<typeof splitLegacy>[0] = {};
  try {
    raw = JSON.parse(await readFile(STORE, "utf8"));
  } catch {
    return emptyCollection();
  }
  const split = splitLegacy(raw);
  if (!split.strip) return split.collection;
  const rules = await readRules();
  if (!rules.topics.length && !rules.sources.length && (split.rules.topics.length || split.rules.sources.length)) {
    await writeAtomic(RULES_FILE, split.rules);
  }
  await writeAtomic(STORE, split.collection);
  return split.collection;
}

async function loadLayer(cwd: string): Promise<ShelfLayer> {
  const collection = await loadCollection();
  const rules = await readRules();
  const root = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { collection, rules, project: null, projectFile: null, remote: "", root: null, remoteBlocked: false };
  const remote = normalizeRemote(await gitText(root, ["remote", "get-url", "origin"]));
  const projectFile = join(root, ".pi", "shelf.json");
  try {
    const parsed = JSON.parse(await readFile(projectFile, "utf8")) as ProjectShelf;
    const fileRemote = typeof parsed.remote === "string" ? parsed.remote : "";
    if (!projectFileUsable(fileRemote, remote)) {
      return { collection, rules, project: null, projectFile, remote, root, remoteBlocked: true };
    }
    return {
      collection,
      rules,
      project: {
        version: 1,
        remote: remote || fileRemote,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        archive: Array.isArray(parsed.archive) ? parsed.archive : [],
        topics: Array.isArray(parsed.topics) ? parsed.topics : [],
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      },
      projectFile,
      remote,
      root,
      remoteBlocked: false,
    };
  } catch {
    return { collection, rules, project: null, projectFile, remote, root, remoteBlocked: false };
  }
}

function rulesOf(layer: ShelfLayer) {
  const projectRules = layer.project
    ? { version: 1 as const, topics: layer.project.topics, sources: layer.project.sources }
    : emptyRules();
  return mergeRules(layer.rules, projectRules);
}

function itemsOf(layer: ShelfLayer) {
  return mergeItems(layer.collection.items, layer.project?.items ?? []);
}

async function saveCollection(collection: Collection) {
  await writeAtomic(STORE, collection);
}

async function saveRules(rules: Rules) {
  forgetStored();
  await writeAtomic(RULES_FILE, rules);
}

async function saveProject(layer: ShelfLayer) {
  if (!layer.projectFile || !layer.root) return;
  layer.project ??= emptyProject(layer.remote);
  layer.project.remote = layer.remote || layer.project.remote;
  await writeAtomic(layer.projectFile, layer.project);
}

function bagFor(layer: ShelfLayer, scope: Scope) {
  if (scope === "project") {
    layer.project ??= emptyProject(layer.remote);
    return layer.project;
  }
  return layer.collection;
}

let storedCache: { at: number; key: string; items: Row[] } | null = null;

function forgetStored() {
  storedCache = null;
}

async function storedItems(cwd: string) {
  if (storedCache && storedCache.key === cwd && Date.now() - storedCache.at < 1500) return storedCache.items;
  const items = [...itemsOf(await loadLayer(cwd)), ...(await promptFileRows(cwd))];
  storedCache = { at: Date.now(), key: cwd, items };
  return items;
}

async function saveScope(layer: ShelfLayer, scope: Scope) {
  forgetStored();
  if (scope === "project") await saveProject(layer);
  else await saveCollection(layer.collection);
}

async function askScope(ctx: ShelfCtx, layer: ShelfLayer, title: string): Promise<Scope | undefined> {
  if (!layer.root) return "global";
  const choice = await ctx.ui.select(title, ["全局", "当前仓库"]);
  if (!choice) return;
  if (choice === "全局") return "global";
  if (layer.remoteBlocked) {
    ctx.ui.notify("这份 .pi/shelf.json 属于别的 git remote，不会写进当前仓库。", "warning");
    return;
  }
  return "project";
}

async function runSource(source: DynamicSource, cwd: string): Promise<Row[]> {
  let stdout = "";
  let ran = false;
  for (const call of shellPlan(process.platform, source.command)) {
    try {
      const result = await execFileAsync(call.command, call.args, {
        cwd,
        timeout: 4000,
        maxBuffer: 256_000,
        windowsHide: true,
      });
      stdout = result.stdout;
      ran = true;
      break;
    } catch {
      continue;
    }
  }
  if (!ran) return [];
  return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 40)
      .map((line) => {
        const [title, value] = line.includes("\t") ? line.split("\t") : [line, line];
        return {
          id: `dyn:${source.id}:${value}`,
          category: source.category,
          title: title || value || "",
          value: value || title || "",
          tags: source.tags,
          source: "manual" as const,
          uses: 0,
          created: "",
          updated: "",
          dynamic: true,
        };
      });
}

async function promptFileRows(cwd: string): Promise<Row[]> {
  const places = [
    { dir: join(homedir(), ".pi", "agent", "prompts"), scope: "global" as const },
    { dir: join(cwd, ".pi", "prompts"), scope: "project" as const },
  ];
  const found: Row[] = [];
  for (const place of places) {
    let names: string[] = [];
    try {
      names = (await readdir(place.dir)).filter((name) => name.endsWith(".md") && !name.startsWith("."));
    } catch {
      continue;
    }
    for (const name of names) {
      const parsed = parsePromptMarkdown(await readFile(join(place.dir, name), "utf8"));
      const title = name.replace(/\.md$/i, "");
      found.push({
        id: `prompt-file:${place.scope}:${title}`,
        category: "Prompt",
        title,
        value: parsed.body.trim(),
        tags: ["pi-prompt", parsed.description, parsed.argumentHint].filter(Boolean),
        source: "manual",
        uses: 0,
        created: "",
        updated: "",
        dynamic: true,
        scope: place.scope,
      });
    }
  }
  return found;
}

async function rows(layer: ShelfLayer, cwd: string): Promise<Row[]> {
  const dynamic = (await Promise.all(rulesOf(layer).sources.map((source) => runSource(source, cwd)))).flat();
  return [...itemsOf(layer), ...dynamic, ...(await promptFileRows(cwd))];
}

function sessionText(ctx: ShelfCtx) {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  const chunks: string[] = [];
  for (const entry of entries) {
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") chunks.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

async function expandTemplate(ctx: ShelfCtx, value: string, args: string[] = []): Promise<string | undefined> {
  const prepared = applyPositionals(value, args);
  const slots = templateSlots(prepared);
  if (!slots.length) return prepared;
  const values: Record<string, string> = {};
  for (const slot of slots) {
    const options = [...slot.choices];
    if (slot.fallback && !options.includes(slot.fallback)) options.unshift(slot.fallback);
    let answer: string | undefined;
    if (options.length) {
      const picked = await ctx.ui.select(`填写 {{${slot.name}}}`, [...options, "自己输入"]);
      if (picked == null) return;
      answer = picked === "自己输入" ? await ctx.ui.input(slot.name, slot.fallback) : picked;
    } else {
      answer = await ctx.ui.input(`填写 {{${slot.name}}}`, slot.fallback);
    }
    if (answer == null) return;
    values[slot.name] = answer;
  }
  return fillTemplate(prepared, values);
}

async function fillEditor(ctx: ShelfCtx) {
  const current = ctx.ui.getEditorText?.() ?? "";
  if (!templateSlots(current).length) {
    ctx.ui.notify("输入框里没有 {{变量}}。", "warning");
    return;
  }
  const next = await expandTemplate(ctx, current);
  if (next == null) return;
  if (ctx.ui.setEditorText) ctx.ui.setEditorText(next);
  else ctx.ui.notify(next, "info");
}

async function promptContextText(ctx: ShelfCtx) {
  const cwd = ctx.cwd ?? process.cwd();
  const dir = join(homedir(), ".pi", "agent", "sessions", sessionFolder(cwd));
  const past: { file: string; title: string; excerpt: string }[] = [];
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort().reverse().slice(0, 8);
    for (const name of names) {
      const item = sessionExcerpt(await readFile(join(dir, name), "utf8"), 700);
      if (item.excerpt.trim()) past.push({ file: name, title: item.title, excerpt: item.excerpt });
    }
  } catch {
    // no saved sessions for this directory
  }
  return JSON.stringify({
    hint: "用这些材料写一条可复用模板。变化的部分写成 {{name}} 或 {{name:选项1|选项2}}。写好后用 action add，category 用 Prompt，等用户确认。",
    current: sessionText(ctx).slice(0, 6000),
    past,
  }, null, 2);
}

function insertValue(ctx: ShelfCtx, value: string) {
  const ui = ctx.ui;
  const current = ui.getEditorText?.() ?? "";
  const token = pathToken(current);
  if (token && ui.setEditorText) {
    ui.setEditorText(current.slice(0, current.length - token.length) + value);
    return;
  }
  const glue = current && !/\s$/.test(current) ? " " : "";
  if (ui.pasteToEditor) ui.pasteToEditor(glue + value);
  else if (ui.setEditorText) ui.setEditorText(current + glue + value);
  else ui.notify(value, "info");
}

async function walkPaths(root: string, kind: "dir" | "file", depth: number, prefix = "", out: string[] = []) {
  if (depth < 0 || out.length >= 3000) return out;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (kind === "dir") out.push(rel);
      await walkPaths(join(root, entry.name), kind, depth - 1, rel, out);
    } else if (kind === "file") out.push(rel);
    if (out.length >= 3000) break;
  }
  return out;
}

async function listPaths(cwd: string, kind: "dir" | "file") {
  try {
    const { stdout } = await execFileAsync(
      "fd",
      ["--type", kind === "dir" ? "d" : "f", "--max-depth", "5", "--exclude", ".git", "--exclude", "node_modules"],
      { cwd, timeout: 4000, maxBuffer: 1_000_000 },
    );
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length) return lines.slice(0, 4000);
  } catch {
    // fd is optional
  }
  return walkPaths(cwd, kind, 4);
}

async function insertPath(ctx: ShelfCtx, kind: "dir" | "file") {
  const draft = ctx.ui.getEditorText?.() ?? "";
  const token = pathToken(draft);
  const seed = token.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const queryText = await ctx.ui.input(kind === "dir" ? "模糊目录，回车插回当前输入" : "模糊文件，回车插回当前输入", seed);
  if (queryText == null) return;
  const matched = (await listPaths(ctx.cwd ?? process.cwd(), kind))
    .map((path) => ({ path, rank: rankPath(path, queryText) }))
    .filter((hit) => hit.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
    .slice(0, 30);
  if (!matched.length) {
    ctx.ui.notify("没有匹配的路径。", "warning");
    return;
  }
  const choice = await ctx.ui.select(`插入到输入框  ${queryText || "全部"}`, matched.map((hit) => hit.path));
  if (!choice) return;
  insertValue(ctx, quotePath(choice));
  ctx.ui.notify(`已插入 ${choice}`, "info");
}

async function upsert(layer: ShelfLayer, draft: { category: string; title: string; value: string; tags?: string[]; source?: Item["source"] }, scope: Scope, ctx?: ShelfCtx) {
  if (scope === "project" && isMachinePath(draft.value)) {
    scope = "global";
    ctx?.ui.notify("这是本机绝对路径，已改存到全局，不写入仓库。", "warning");
  }
  const bag = bagFor(layer, scope);
  const valueKey = draft.value.trim().toLowerCase();
  bag.archive = bag.archive.filter((item) => item.value.trim().toLowerCase() !== valueKey);
  const existing = bag.items.find(
    (item) => item.value.trim().toLowerCase() === valueKey && item.category.toLowerCase() === draft.category.toLowerCase(),
  );
  if (existing) {
    existing.title = draft.title || existing.title;
    existing.tags = normTags([...(existing.tags ?? []), ...(draft.tags ?? [])]);
    existing.updated = now();
    existing.source = draft.source ?? existing.source;
    await saveScope(layer, scope);
    return existing;
  }
  const item: Item = {
    id: `${slug(draft.category)}-${slug(draft.title)}-${Date.now().toString(36)}`,
    category: draft.category.trim(),
    title: draft.title.trim(),
    value: draft.value.trim(),
    tags: normTags(draft.tags ?? []),
    source: draft.source ?? "manual",
    uses: 0,
    created: now(),
    updated: now(),
  };
  bag.items.push(item);
  await saveScope(layer, scope);
  return item;
}

async function usePrompt(ctx: ShelfCtx, tail: string) {
  const [name, ...given] = splitArgs(tail);
  if (!name) return pick(ctx, "", true);
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const prompts = (await rows(layer, ctx.cwd ?? process.cwd())).filter(
    (row) => row.id.startsWith("prompt-file:") || row.category.toLowerCase() === "prompt" || templateSlots(row.value).length > 0 || /\$\d|\$\{|\$@|\$ARGUMENTS/.test(row.value),
  );
  const exact = prompts.filter((row) => {
    const file = row.id.startsWith("prompt-file:") ? row.id.split(":").pop() : "";
    return row.title.toLowerCase() === name.toLowerCase() || file?.toLowerCase() === name.toLowerCase();
  });
  let row = exact.length === 1 ? exact[0] : undefined;
  if (!row) {
    const query = parseQuery(name);
    const matched = prompts
      .map((item) => ({ item, rank: score(item, query) }))
      .filter((hit) => hit.rank !== Infinity)
      .sort((a, b) => a.rank - b.rank);
    if (matched.length === 1) row = matched[0]?.item;
    else if (matched.length) {
      const choice = await ctx.ui.select("选择提示词", matched.slice(0, 30).map((hit) => label(hit.item)));
      row = matched.find((hit) => label(hit.item) === choice)?.item;
    }
  }
  if (!row) {
    ctx.ui.notify(`没有名为 ${name} 的提示词。`, "warning");
    return;
  }
  const text = await expandTemplate(ctx, row.value, given);
  if (text == null) return;
  insertValue(ctx, text);
  ctx.ui.notify(`已插入输入框：${text}`, "info");
}

async function pick(ctx: ShelfCtx, initial = "", onlyTemplates = false) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const queryText = await ctx.ui.input("筛选：@类  #标签  关键字（可叠加）", initial);
  if (queryText == null) return;
  const query = parseQuery(queryText);
  const matched = (await rows(layer, ctx.cwd ?? process.cwd()))
    .filter((row) => !onlyTemplates || templateSlots(row.value).length > 0 || row.category.toLowerCase() === "prompt")
    .map((row) => ({ row, rank: score(row, query) }))
    .filter((hit) => hit.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || b.row.uses - a.row.uses)
    .slice(0, 30);
  if (!matched.length) {
    ctx.ui.notify("没有匹配。/shelf add 新增，或放宽标签。", "warning");
    return;
  }
  const choice = await ctx.ui.select(
    `架子（${matched.length}）  回车插入输入框  ${queryText || "全部"}`,
    matched.map((hit) => label(hit.row)),
  );
  const row = matched.find((hit) => label(hit.row) === choice)?.row;
  if (!row) return;
  const text = await expandTemplate(ctx, row.value);
  if (text == null) return;
  if (!row.dynamic && row.scope) {
    const bag = bagFor(layer, row.scope);
    const stored = bag.items.find((item) => item.id === row.id);
    if (stored) {
      stored.uses += 1;
      stored.updated = now();
      await saveScope(layer, row.scope);
    }
  }
  insertValue(ctx, text);
  ctx.ui.notify(`已插入输入框：${text}`, "info");
}

async function addFlow(ctx: ShelfCtx, presetCategory = "") {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const category = await ctx.ui.input("类别", presetCategory || "GitHub");
  if (!category) return;
  const title = await ctx.ui.input("标题");
  if (!title) return;
  const value = await ctx.ui.input(category.toLowerCase() === "prompt" ? "模板。变量写成 {{name}} 或 {{name:甲|乙}}" : "插入内容（URL / 命令 / 笔记）");
  if (!value) return;
  const tags = await ctx.ui.input("标签，空格分隔", "");
  const scope = await askScope(ctx, layer, "存到哪里");
  if (!scope) return;
  const item = await upsert(layer, { category, title, value, tags: (tags ?? "").split(/[\s,]+/), source: "manual" }, scope, ctx);
  ctx.ui.notify(`已保存到${scope === "project" ? "仓库" : "全局"} @${item.category} ${item.title}`, "info");
}

async function editItem(ctx: ShelfCtx, layer: ShelfLayer, item: ScopedItem) {
  const bag = bagFor(layer, item.scope);
  const stored = bag.items.find((entry) => entry.id === item.id);
  if (!stored) return;
  const title = await ctx.ui.input("标题", stored.title);
  const value = await ctx.ui.input("插入内容", stored.value);
  const tags = await ctx.ui.input("标签", stored.tags.join(" "));
  const category = await ctx.ui.input("类别", stored.category);
  if (!title || !value || !category) return;
  stored.title = title;
  stored.value = value;
  stored.category = category;
  stored.tags = normTags((tags ?? "").split(/[\s,]+/));
  stored.updated = now();
  await saveScope(layer, item.scope);
  ctx.ui.notify(`已更新 ${stored.title}`, "info");
}

async function removeItem(ctx: ShelfCtx, layer: ShelfLayer, item: ScopedItem) {
  if (!(await ctx.ui.confirm(`归档 @${item.category} ${item.title}？ /shelf restore 可以恢复`, false))) return;
  const bag = bagFor(layer, item.scope);
  archiveItem(bag, item.id, now());
  await saveScope(layer, item.scope);
  ctx.ui.notify("已归档", "info");
}

async function restoreFlow(ctx: ShelfCtx, layer: ShelfLayer) {
  const archived: ScopedItem[] = [
    ...layer.collection.archive.map((item) => ({ ...item, scope: "global" as const })),
    ...(layer.project?.archive ?? []).map((item) => ({ ...item, scope: "project" as const })),
  ];
  if (!archived.length) {
    ctx.ui.notify("归档是空的。", "warning");
    return;
  }
  const choice = await ctx.ui.select("恢复", archived.map((item) => `${item.scope === "project" ? "仓库" : "全局"}  ${label(item)}`));
  const item = archived.find((entry) => `${entry.scope === "project" ? "仓库" : "全局"}  ${label(entry)}` === choice);
  if (!item) return;
  restoreItem(bagFor(layer, item.scope), item.id, now());
  await saveScope(layer, item.scope);
  ctx.ui.notify(`已恢复 ${item.title}`, "info");
}

async function chooseItem(ctx: ShelfCtx, layer: ShelfLayer, title: string) {
  const items = itemsOf(layer);
  if (!items.length) {
    ctx.ui.notify("架子是空的。", "warning");
    return;
  }
  const choice = await ctx.ui.select(title, items.map((item) => label(item)));
  return items.find((item) => label(item) === choice);
}

function knownTopics(rules: Rules) {
  return [...BUILTIN_TOPICS, ...rules.topics.map((topic) => topic.id)];
}

async function harvest(ctx: ShelfCtx, fromAgent = false, topicArg = "") {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const rules = rulesOf(layer);
  const items = itemsOf(layer);
  let topic = topicArg.trim().toLowerCase();
  const all = harvestHits(sessionText(ctx), rules.topics).filter(
    (hit) => !items.some((item) => item.category.toLowerCase() === hit.category.toLowerCase() && item.value.toLowerCase() === hit.value.toLowerCase()),
  );
  if (!all.length) {
    const msg = "这次会话里没有新的可收集条目。";
    ctx.ui.notify(msg, "info");
    return msg;
  }
  if (!topic) {
    const topics = [...new Set(all.map((hit) => hit.topic))];
    if (topics.length > 1) {
      const picked = await ctx.ui.select(
        "收哪一类",
        ["全部", ...topics.map((name) => `${name}  ${all.filter((hit) => hit.topic === name).length}`)],
      );
      if (!picked) return "用户取消了入库。";
      topic = picked === "全部" ? "" : picked.split(/\s+/)[0]!.toLowerCase();
    }
  } else if (![...BUILTIN_TOPICS, ...rules.topics.map((item) => item.id.toLowerCase())].includes(topic)) {
    const msg = `未知 topic：${topicArg}。可用 ${knownTopics(rules).join("、")}。`;
    ctx.ui.notify(msg, "warning");
    return msg;
  }
  const hits = topic ? all.filter((hit) => hit.topic === topic) : all;
  if (!hits.length) {
    const msg = `这次会话里没有新的 ${topic} 条目。`;
    ctx.ui.notify(msg, "info");
    return msg;
  }
  const preview = hits.slice(0, 12).map((hit) => `${hit.n}×  @${hit.category}  ${hit.title}`).join("\n");
  const mode = await ctx.ui.select(`发现 ${hits.length} 条未收录\n${preview}`, ["并入全部", "只收出现≥2次", "逐条确认", "取消"]);
  if (!mode || mode === "取消") return "用户取消了入库。";
  let added = 0;
  for (const hit of hits) {
    if (mode === "只收出现≥2次" && hit.n < 2) continue;
    if (mode === "逐条确认") {
      const ok = await ctx.ui.confirm(`并入 @${hit.category} ${hit.title}\n${hit.value}\n出现 ${hit.n} 次`, hit.n >= 2);
      if (!ok) continue;
    }
    await upsert(layer, {
      category: hit.category,
      title: hit.title,
      value: hit.value,
      tags: [...hit.tags, fromAgent ? "harvest" : "session"],
      source: fromAgent ? "agent" : "manual",
    }, "global", ctx);
    added += 1;
  }
  const msg = `已并入 ${added} 条。`;
  ctx.ui.notify(msg, "info");
  return msg;
}

async function addTopic(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const id = await ctx.ui.input("topic 名，例如 empiar");
  const category = await ctx.ui.input("入库类别", id || "Note");
  const tags = await ctx.ui.input("标签，空格分隔", id ?? "");
  const pattern = await ctx.ui.input("正则。第 1 组是插入值，第 2 组可选作标题", id ? `${id}-\\d+` : "");
  if (!id || !category || !pattern) return;
  try {
    new RegExp(pattern, "gi");
  } catch {
    ctx.ui.notify("正则无效。", "warning");
    return;
  }
  const scope = await askScope(ctx, layer, "规则存到哪里");
  if (!scope) return;
  const topic = { id, category, tags: normTags((tags ?? "").split(/[\s,]+/)), pattern };
  if (scope === "project") {
    const project = bagFor(layer, "project");
    project.topics = project.topics.filter((item) => item.id.toLowerCase() !== id.toLowerCase());
    project.topics.push(topic);
    await saveProject(layer);
  } else {
    layer.rules.topics = layer.rules.topics.filter((item) => item.id.toLowerCase() !== id.toLowerCase());
    layer.rules.topics.push(topic);
    await saveRules(layer.rules);
  }
  ctx.ui.notify(`已加 topic ${id} 到${scope === "project" ? "仓库规则" : "全局规则"}。`, "info");
}

async function addSource(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const category = await ctx.ui.input("动态源类别", "GitHub");
  const sample = process.platform === "win32" ? "Get-ChildItem -Name" : "git remote -v";
  const command = await ctx.ui.input("命令。每行 标题<TAB>值。Windows 默认 PowerShell，也可写 cmd: 或 bash:", sample);
  const tags = await ctx.ui.input("标签", "dynamic");
  if (!category || !command) return;
  const scope = await askScope(ctx, layer, "规则存到哪里");
  if (!scope) return;
  const source = { id: `src-${Date.now().toString(36)}`, category, command, tags: normTags((tags ?? "").split(/[\s,]+/)) };
  if (scope === "project") {
    bagFor(layer, "project").sources.push(source);
    await saveProject(layer);
  } else {
    layer.rules.sources.push(source);
    await saveRules(layer.rules);
  }
  ctx.ui.notify("动态源已加。打开 /shelf 时现算，结果不落盘。", "info");
}

function topicEntries(layer: ShelfLayer) {
  return [
    ...layer.rules.topics.map((topic) => ({ ...topic, scope: "global" as const })),
    ...(layer.project?.topics ?? []).map((topic) => ({ ...topic, scope: "project" as const })),
  ];
}

function sourceEntries(layer: ShelfLayer) {
  return [
    ...layer.rules.sources.map((source) => ({ ...source, scope: "global" as const })),
    ...(layer.project?.sources ?? []).map((source) => ({ ...source, scope: "project" as const })),
  ];
}

function topicLabel(topic: TopicDef & { scope: Scope }) {
  return `${topic.scope === "project" ? "仓库" : "全局"}  ${topic.id}  @${topic.category}`;
}

function sourceLabel(source: DynamicSource & { scope: Scope }) {
  return `${source.scope === "project" ? "仓库" : "全局"}  @${source.category}  ${source.command}`;
}

async function manageTopics(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const action = await ctx.ui.select("topic", ["新增", "编辑", "删除", "列出"]);
  if (action === "新增") return addTopic(ctx);
  const entries = topicEntries(layer);
  if (action === "列出") {
    ctx.ui.notify(entries.map(topicLabel).join("\n") || "没有自定义 topic。", "info");
    return;
  }
  if (action !== "编辑" && action !== "删除") return;
  if (!entries.length) {
    ctx.ui.notify("没有自定义 topic。", "warning");
    return;
  }
  const choice = await ctx.ui.select(action === "编辑" ? "编辑 topic" : "删除 topic", entries.map(topicLabel));
  const topic = entries.find((item) => topicLabel(item) === choice);
  if (!topic) return;
  const project = topic.scope === "project";
  if (action === "删除") {
    if (!(await ctx.ui.confirm(`删除 topic ${topic.id}？`, false))) return;
    if (project) layer.project!.topics = layer.project!.topics.filter((item) => item.id !== topic.id);
    else layer.rules.topics = layer.rules.topics.filter((item) => item.id !== topic.id);
    if (project) await saveProject(layer);
    else await saveRules(layer.rules);
    ctx.ui.notify(`已删除 topic ${topic.id}`, "info");
    return;
  }
  const category = await ctx.ui.input("入库类别", topic.category);
  const tags = await ctx.ui.input("标签，空格分隔", topic.tags.join(" "));
  const pattern = await ctx.ui.input("正则", topic.pattern);
  if (!category || !pattern) return;
  try {
    new RegExp(pattern, "gi");
  } catch {
    ctx.ui.notify("正则无效。", "warning");
    return;
  }
  const next = { id: topic.id, category, tags: normTags((tags ?? "").split(/[\s,]+/)), pattern };
  if (project) {
    layer.project!.topics = [...layer.project!.topics.filter((item) => item.id !== topic.id), next];
    await saveProject(layer);
  } else {
    layer.rules.topics = [...layer.rules.topics.filter((item) => item.id !== topic.id), next];
    await saveRules(layer.rules);
  }
  ctx.ui.notify(`已更新 topic ${topic.id}`, "info");
}

async function manageSources(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const action = await ctx.ui.select("动态源", ["新增", "编辑", "删除", "列出"]);
  if (action === "新增") return addSource(ctx);
  const entries = sourceEntries(layer);
  if (action === "列出") {
    ctx.ui.notify(entries.map(sourceLabel).join("\n") || "没有动态源。", "info");
    return;
  }
  if (action !== "编辑" && action !== "删除") return;
  if (!entries.length) {
    ctx.ui.notify("没有动态源。", "warning");
    return;
  }
  const choice = await ctx.ui.select(action === "编辑" ? "编辑动态源" : "删除动态源", entries.map(sourceLabel));
  const source = entries.find((item) => sourceLabel(item) === choice);
  if (!source) return;
  const project = source.scope === "project";
  if (action === "删除") {
    if (!(await ctx.ui.confirm(`删除动态源 ${source.command}？`, false))) return;
    if (project) layer.project!.sources = layer.project!.sources.filter((item) => item.id !== source.id);
    else layer.rules.sources = layer.rules.sources.filter((item) => item.id !== source.id);
    if (project) await saveProject(layer);
    else await saveRules(layer.rules);
    ctx.ui.notify("已删除动态源", "info");
    return;
  }
  const category = await ctx.ui.input("类别", source.category);
  const command = await ctx.ui.input("命令", source.command);
  const tags = await ctx.ui.input("标签", source.tags.join(" "));
  if (!category || !command) return;
  const next = { ...source, category, command, tags: normTags((tags ?? "").split(/[\s,]+/)) };
  const { scope: _scope, ...stored } = next;
  if (project) {
    layer.project!.sources = [...layer.project!.sources.filter((item) => item.id !== source.id), stored];
    await saveProject(layer);
  } else {
    layer.rules.sources = [...layer.rules.sources.filter((item) => item.id !== source.id), stored];
    await saveRules(layer.rules);
  }
  ctx.ui.notify("已更新动态源", "info");
}

async function pinDynamic(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const dynamic = (await rows(layer, ctx.cwd ?? process.cwd())).filter((row) => row.dynamic);
  if (!dynamic.length) {
    ctx.ui.notify("没有动态条目。先 /shelf source。", "warning");
    return;
  }
  const choice = await ctx.ui.select("钉住为永久条目", dynamic.map(label));
  const row = dynamic.find((item) => label(item) === choice);
  if (!row) return;
  const scope = await askScope(ctx, layer, "钉到哪里");
  if (!scope) return;
  await upsert(layer, { category: row.category, title: row.title, value: row.value, tags: row.tags, source: "pinned" }, scope, ctx);
  ctx.ui.notify(`已钉住 ${row.title}`, "info");
}

type CompleteItem = { value: string; label: string; description?: string };
type CompleteProvider = {
  triggerCharacters?: string[];
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) => Promise<{ items: CompleteItem[]; prefix: string } | null>;
  applyCompletion: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: CompleteItem,
    prefix: string,
  ) => { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean;
};

const remoteListings = new Map<string, { at: number; text: string }>();

function shQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function readSshHosts(): Promise<SshHosts> {
  const dir = join(homedir(), ".ssh");
  const known: SshHosts = { hosts: [], patterns: [] };
  try {
    const parsed = parseSshConfigHosts(await readFile(join(dir, "config"), "utf8"));
    known.hosts.push(...parsed.hosts);
    known.patterns.push(...parsed.patterns);
  } catch {
    // no config
  }
  try {
    known.hosts.push(...parseKnownHosts(await readFile(join(dir, "known_hosts"), "utf8")));
  } catch {
    // no known hosts
  }
  return known;
}

async function remoteListing(destination: string, listDir: string, signal: AbortSignal) {
  const key = `${destination}\n${listDir}`;
  const cached = remoteListings.get(key);
  if (cached && Date.now() - cached.at < 10_000) return cached.text;
  const { stdout } = await execFileAsync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-o", "LogLevel=ERROR", destination, `ls -1Ap -- ${shQuote(listDir || ".")}`],
    { timeout: 5000, signal, maxBuffer: 200_000 },
  );
  remoteListings.set(key, { at: Date.now(), text: stdout });
  return stdout;
}

function installAutocomplete(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const known = await readSshHosts();
    const ui = ctx.ui as ShelfUi & {
      addAutocompleteProvider?: (factory: (current: CompleteProvider) => CompleteProvider) => void;
      onTerminalInput?: (handler: (data: string) => { data?: string } | undefined) => void;
    };
    ui.onTerminalInput?.((data) => {
      if (isAltSlash(data)) return { data: "\t" };
    });
    ui.addAutocompleteProvider?.((current) => ({
      triggerCharacters: [":", "@", "#"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
        if (slashCommandToken(before)) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const token = parseRemoteToken(before);
        if (token && hostAllowed(token.destination, known)) {
          try {
            const listing = await remoteListing(token.destination, token.listDir, options.signal);
            const items = remoteItems(token, remoteEntries(listing, token.namePrefix)).map((item) => ({
              ...item,
              shelfKind: "remote" as const,
            }));
            if (items.length) return { items, prefix: token.prefix };
          } catch {
            return null;
          }
        }
        if (!pathToken(before)) {
          const seed = draftSeed(before);
          const cwd = (ctx as ShelfCtx).cwd ?? process.cwd();
          const matches = shelfMatches(await storedItems(cwd), seed, options.force === true);
          if (matches.length) {
            return {
              items: matches.map((hit) => ({
                value: hit.row.value,
                label: hit.row.title,
                description: `@${hit.row.category}${templateSlots(hit.row.value).length ? " 模板" : ""}`,
                shelfKind: "shelf" as const,
              })),
              prefix: seed,
            };
          }
        }
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const marked = item as CompleteItem & { shelfKind?: string };
        if (marked.shelfKind !== "shelf" && marked.shelfKind !== "remote") {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        }
        return applyRemoteCompletion(lines, cursorLine, cursorCol, item.value, prefix, item.label.endsWith("/"));
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
        if (slashCommandToken(before)) return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
        const token = parseRemoteToken(before);
        if (token && hostAllowed(token.destination, known)) return true;
        if (!pathToken(before)) return true;
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}

export default function (pi: ExtensionAPI) {
  installAutocomplete(pi);
  pi.registerCommand("shelf", {
    description: "分类架子：筛选后插入 / add / edit / rm / restore / harvest [topic] / topic / source / pin / prompt / fill",
    handler: async (args, ctx) => {
      const shelf = ctx as ShelfCtx;
      const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const layer = await loadLayer(shelf.cwd ?? process.cwd());
      if (!verb) return pick(shelf);
      if (verb === "add") return addFlow(shelf, rest.join(" "));
      if (verb === "harvest") return harvest(shelf, false, rest.join(" "));
      if (verb === "topic") return manageTopics(shelf);
      if (verb === "pin") return pinDynamic(shelf);
      if (verb === "restore") return restoreFlow(shelf, layer);
      if (verb === "list") {
        const query = parseQuery(rest.join(" "));
        const matched = itemsOf(layer).filter((item) => score(item, query) !== Infinity);
        shelf.ui.notify(matched.map((item) => label(item)).join("\n") || "空", "info");
        return;
      }
      if (verb === "edit" || verb === "rm") {
        const item = await chooseItem(shelf, layer, verb === "edit" ? "编辑" : "归档");
        if (!item) return;
        return verb === "edit" ? editItem(shelf, layer, item) : removeItem(shelf, layer, item);
      }
      if (verb === "source") return manageSources(shelf);
      if (verb === "prompt") {
        const tail = args.trim().replace(/^prompt\b/, "").trim();
        if (!tail) return pick(shelf, "", true);
        if (tail === "add" || tail.startsWith("add ")) return addFlow(shelf, "Prompt");
        return usePrompt(shelf, tail);
      }
      if (verb === "fill") return fillEditor(shelf);
      if (verb === "dir" || verb === "file") return insertPath(shelf, verb);
      return pick(shelf, args.trim());
    },
  });

  pi.registerShortcut("ctrl+shift+k", {
    description: "打开架子并把选中项插入当前输入，不清掉已打的字",
    handler: async (ctx) => {
      const shelf = ctx as ShelfCtx;
      return pick(shelf, draftSeed(shelf.ui.getEditorText?.() ?? ""));
    },
  });

  pi.registerShortcut("ctrl+shift+o", {
    description: "模糊选目录并插入当前输入",
    handler: async (ctx) => insertPath(ctx as ShelfCtx, "dir"),
  });

  pi.registerTool({
    name: "shelf",
    label: "架子",
    description: "Search, add, update, delete, harvest, or draft prompt templates. Writes require user confirmation. Search does not insert.",
    promptSnippet: "Categorized shelf, including prompt templates with {{variables}}.",
    promptGuidelines: [
      "Use the shelf tool to recall a saved URL, paper, dataset id, note, or prompt template instead of guessing.",
      "Tags are AND. Category is fuzzy. Do not edit store.json, config.json, or .pi/shelf.json yourself.",
      "To collect from the current session, call action harvest with topic github, doi, arxiv, url, a custom topic id, or all. Always let the user confirm before writing.",
      "When the user describes a reusable prompt, write it as a template. Free fields are {{name}}. Choices are {{name:one|two}}. Defaults are {{name=value}}. Save with action add, category Prompt, and wait for confirmation.",
      "To summarize this conversation or past ones into a template, call action prompt_context first. It returns the current session and this project's recent sessions. Then draft one template and add it. Do not invent variables that the sessions do not support.",
      "Do not claim text was inserted into the editor. /shelf and ctrl+shift+k expand variables and then insert. Autocomplete inserts the template text; /shelf fill expands variables already in the editor.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "search | add | update | delete | harvest | harvest_github | list | prompt_context" }),
      topic: Type.Optional(Type.String({ description: "Harvest topic: github, doi, arxiv, url, a custom id, or all." })),
      query: Type.Optional(Type.String({ description: "Fuzzy text. Tags use #tag, category uses @Category." })),
      category: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      id: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String({ description: "global or project. Harvest always writes global." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const shelf = ctx as ShelfCtx;
      const layer = await loadLayer(shelf.cwd ?? process.cwd());
      if (params.action === "list" || params.action === "search") {
        const query = parseQuery([params.category ? `@${params.category}` : "", ...(params.tags ?? []).map((tag: string) => `#${tag}`), params.query ?? ""].join(" "));
        const matched = (await rows(layer, shelf.cwd ?? process.cwd()))
          .filter((row) => score(row, query) !== Infinity)
          .slice(0, 20)
          .map((row) => ({ id: row.id, category: row.category, title: row.title, value: row.value, tags: row.tags, dynamic: !!row.dynamic, scope: row.scope ?? "" }));
        return { content: [{ type: "text", text: JSON.stringify(matched, null, 2) }], details: { matched } };
      }
      if (params.action === "harvest" || params.action === "harvest_github") {
        const topic = params.action === "harvest_github" ? "github" : (params.topic ?? "");
        return { content: [{ type: "text", text: await harvest(shelf, true, topic) }], details: {} };
      }
      if (params.action === "prompt_context") {
        const text = await promptContextText(shelf);
        return { content: [{ type: "text", text }], details: {} };
      }
      if (params.action === "add" || params.action === "update") {
        if (!params.category || !params.title || !params.value) {
          return { content: [{ type: "text", text: "add/update 需要 category、title、value。" }], details: {} };
        }
        const slots = templateSlots(params.value);
        const slotNote = slots.length ? `\n变量：${slots.map((slot) => slot.name).join(", ")}` : "";
        const ok = await shelf.ui.confirm(`并入 @${params.category} ${params.title}\n${params.value}${slotNote}\n#${(params.tags ?? []).join(" #")}`, true);
        if (!ok) return { content: [{ type: "text", text: "用户拒绝并入。" }], details: {} };
        const scope: Scope = params.scope === "project" ? "project" : "global";
        if (scope === "project" && (!layer.root || layer.remoteBlocked)) {
          return { content: [{ type: "text", text: "当前目录没有可写的仓库架子。" }], details: {} };
        }
        const item = await upsert(layer, { category: params.category, title: params.title, value: params.value, tags: params.tags, source: "agent" }, scope, shelf);
        return { content: [{ type: "text", text: `已保存 ${item.id}` }], details: { item } };
      }
      if (params.action === "delete") {
        const item = itemsOf(layer).find((entry) => entry.id === params.id || entry.value === params.value);
        if (!item) return { content: [{ type: "text", text: "没有这条。" }], details: {} };
        if (!(await shelf.ui.confirm(`归档 ${item.title}？`, false))) {
          return { content: [{ type: "text", text: "用户拒绝归档。" }], details: {} };
        }
        archiveItem(bagFor(layer, item.scope), item.id, now());
        await saveScope(layer, item.scope);
        return { content: [{ type: "text", text: `已归档 ${item.id}` }], details: {} };
      }
      return { content: [{ type: "text", text: "未知 action。" }], details: {} };
    },
  });
}
