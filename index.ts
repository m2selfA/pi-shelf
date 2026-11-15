import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BUILTIN_TOPICS,
  choices,
  fuzzy,
  harvestHits,
  label,
  normTags,
  parseQuery,
  draftSeed,
  isMachinePath,
  isPathLikeToken,
  isPromptRow,
  pathToken,
  quotePath,
  rankPath,
  rankRows,
  score,
  shelfCompletionContext,
  shelfInterceptionContext,
  shelfMatches,
  slashCommandToken,
  type Item,
  type Row,
  type TopicDef,
} from "./src/match.ts";
import { applyPositionals, fillTemplate, parsePromptMarkdown, sessionExcerpt, sessionFolder, splitArgs, templateSlots } from "./src/template.ts";
import { createPicker } from "./src/picker.ts";
import { composeParts, type Part } from "./src/compose.ts";
import { expandShortcuts } from "./src/shortcut.ts";
import { packageIdentity, rankPackages, rankTools, toolToken, type ToolLike } from "./src/tools.ts";
import { completionScores, emptyCompletionStats, parseCompletionStats, recordCompletion, type CompletionStats } from "./src/completions.ts";
import { ALIAS_MACROS, aliasKeyValid, expandAlias, matchAliases, type AliasScript } from "./src/alias.ts";
import { captureScreenshot, readClipboardImage, saveTempImage } from "./src/image.ts";
import { parseTarget, rankTargets } from "./src/target.ts";
import { checkUrl, enrichUrl } from "./src/enrich.ts";
import {
  applyRemoteCompletion,
  hostAllowed,
  isAltSlash,
  localDriveItems,
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
  hashText,
  mergeCollection,
  mergeProject,
  trustState,
  type ValueProvider,
  mergeItems,
  mergeRules,
  normalizeRemote,
  projectFileUsable,
  restoreItem,
  shellPlan,
  splitLegacy,
  type Alias,
  type Collection,
  type DynamicSource,
  type ProjectShelf,
  type Rules,
  type Scope,
  type ScopedItem,
} from "./src/store.ts";

const execFileAsync = promisify(execFile);

function runAliasScriptSync(script: AliasScript, cwd: string): string {
  const prefix = script.language === "bash" ? "bash:" : "powershell:";
  const calls = shellPlan(process.platform, `${prefix} ${script.source}`, cwd);
  if (!calls.length) throw new Error("脚本为空。");
  let lastError: unknown;
  for (const call of calls) {
    try {
      const stdout = execFileSync(call.command, call.args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
      return stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

let clipboardCache: { at: number; value: string | undefined } | undefined;
/** Read the system clipboard once per second; undefined means "leave {{clipboard}} literal". */
async function readClipboard(): Promise<string | undefined> {
  if (clipboardCache && Date.now() - clipboardCache.at < 1000) return clipboardCache.value;
  const commands: Array<[string, string[]]> =
    process.platform === "win32"
      ? [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]]
      : process.platform === "darwin"
        ? [["pbpaste", []]]
        : [["wl-paste", ["-n"]], ["xclip", ["-selection", "clipboard", "-o"]]];
  let value: string | undefined;
  for (const [command, args] of commands) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 1500, maxBuffer: 1024 * 1024 });
      value = stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
      break;
    } catch {
      // try the next platform tool
    }
  }
  clipboardCache = { at: Date.now(), value };
  return value;
}
// getAgentDir honours PI_CODING_AGENT_DIR; hardcoding ~/.pi/agent silently split the shelf
// into two stores whenever the agent directory was relocated.
const SHELF_DIR = join(getAgentDir(), "pi-shelf");
const STORE = join(SHELF_DIR, "store.json");
const RULES_FILE = join(SHELF_DIR, "config.json");
const TRUST_FILE = join(SHELF_DIR, "trust.json");
const DIAGNOSTICS_FILE = join(SHELF_DIR, "diagnostics.json");
const COMPLETIONS_FILE = join(SHELF_DIR, "completions.json");

type ShelfLayer = {
  collection: Collection;
  rules: Rules;
  project: ProjectShelf | null;
  projectFile: string | null;
  remote: string;
  root: string | null;
  remoteBlocked: boolean;
  /** Set when .pi/shelf.json changed since it was approved; project commands stay off. */
  trustBlocked: { hash: string; approved: string } | null;
  /** Set when a shelf file exists but cannot be parsed; writes must not overwrite it. */
  corrupt: string | null;
};

// Mirrors Pi's ExtensionUIContext: confirm takes (title, message), and ui.input has no
// prefill (its second argument is an unused placeholder), so a dialog that must show an
// existing value goes through ui.editor instead.
type ShelfUi = {
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  confirm: (title: string, message: string) => Promise<boolean>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
  pasteToEditor?: (text: string) => void;
  setEditorText?: (text: string) => void;
  getEditorText?: () => string;
  /** TUI-only: Pi 1.2 hands the whole interactive area to a component. */
  custom?: <T>(factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component & { dispose?: () => void }) => Promise<T>;
};

type ShelfCtx = {
  ui: ShelfUi;
  /** "tui" | "rpc" | "print"; custom components are only valid in "tui". */
  mode?: string;
  cwd?: string;
  sessionManager?: { getEntries?: () => unknown[] };
  /** Pi 1.2+ reports whether project-local resources are trusted for this cwd. */
  isProjectTrusted?: () => boolean;
};

const CANCEL = "取消";

/** Pi 1.2+ always provides this; the fallback only covers older runtimes. */
function projectTrusted(ctx: ShelfCtx) {
  return ctx.isProjectTrusted?.() ?? true;
}

let warnedUntrusted = false;

function warnUntrusted(ctx: ShelfCtx) {
  if (warnedUntrusted) return;
  warnedUntrusted = true;
  ctx.ui.notify("这个仓库未受信任，已跳过它自带的动态源。", "warning");
}

/**
 * Pi's ui.confirm renders Yes/No and always preselects Yes, so it must never guard a
 * destructive action. Ask with the safe choice first: Enter and Esc both leave data alone.
 */
async function confirmDestructive(ctx: ShelfCtx, title: string, action: string, detail = "") {
  const choice = await ctx.ui.select(detail ? `${title}\n${detail}` : title, [CANCEL, action]);
  return choice === action;
}

/**
 * An existing value that must survive the dialog. ui.editor prefills it for real; without
 * ui.editor an empty answer keeps the value named in the title instead of dropping it.
 */
async function askText(ctx: ShelfCtx, title: string, seed = ""): Promise<string | undefined> {
  if (seed && ctx.ui.editor) return ctx.ui.editor(title, seed);
  const answer = await ctx.ui.input(seed ? `${title}（回车保留：${seed}）` : title);
  if (answer == null) return undefined;
  return answer || seed;
}

/** A suggested default rather than an existing value: Enter accepts it. */
async function askDefault(ctx: ShelfCtx, title: string, fallback = ""): Promise<string | undefined> {
  const answer = await ctx.ui.input(fallback ? `${title}（回车用：${fallback}）` : title);
  if (answer == null) return undefined;
  return answer || fallback;
}

function now() {
  return new Date().toISOString();
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
}

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Write through a unique temp file so two Pi windows (or a crash mid-write) can never
 * leave a half-written shelf on disk. A fixed ".tmp" name would let two writers clobber
 * each other's temp file before either rename.
 */
async function writeAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, jsonText(value), "utf8");
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

const LOCK_WAIT_MS = 4_000;
const LOCK_STALE_MS = 30_000;

/**
 * Serialize a read-modify-write across Pi windows. The lock is a directory because mkdir
 * is atomic on every platform; a lock older than LOCK_STALE_MS is presumed abandoned
 * (a writer that crashed between mkdir and rmdir) and is removed once.
 */
async function withStoreLock<T>(target: string, run: () => Promise<T>): Promise<T> {
  const lock = `${target}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const started = Date.now();
  let held = false;
  for (let attempt = 0; !held; attempt += 1) {
    try {
      await mkdir(lock);
      held = true;
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (attempt === 0) {
        try {
          const info = await stat(lock);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await rmdir(lock).catch(() => undefined);
            continue;
          }
        } catch {
          // the holder released it between mkdir and stat
          continue;
        }
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        // Never block a picker indefinitely: proceed unlocked rather than lose the edit.
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 10));
    }
  }
  try {
    return await run();
  } finally {
    if (held) await rmdir(lock).catch(() => undefined);
  }
}

async function gitText(cwd: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Shelf files whose JSON could not be parsed. They are read as empty so the UI still
 * opens, but they are never written back: one /shelf add would otherwise replace the
 * user's whole store with a single item.
 */
const corrupt = new Set<string>();

function parseFailure(path: string, error: unknown) {
  if ((error as { code?: string }).code === "ENOENT") return;
  corrupt.add(path);
}

function refuseOverwrite(path: string) {
  if (!corrupt.has(path)) return;
  throw new Error(`拒绝写入 ${path}：它不是有效 JSON。先修好或移走这个文件，/shelf doctor 会列出全部问题。`);
}

async function readRules(): Promise<Rules> {
  try {
    const parsed = JSON.parse(await readFile(RULES_FILE, "utf8")) as Rules;
    return {
      version: 1,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      values: Array.isArray(parsed.values) ? parsed.values : [],
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
    };
  } catch (error) {
    parseFailure(RULES_FILE, error);
    return emptyRules();
  }
}

async function loadCollection(): Promise<Collection> {
  let raw: Parameters<typeof splitLegacy>[0] = {};
  try {
    raw = JSON.parse(await readFile(STORE, "utf8"));
  } catch (error) {
    parseFailure(STORE, error);
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

type TrustFile = { version: 1; projects: Record<string, { hash: string; approvedAt: string }> };

async function readTrust(): Promise<TrustFile> {
  try {
    const parsed = JSON.parse(await readFile(TRUST_FILE, "utf8")) as TrustFile;
    return { version: 1, projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

async function writeTrust(trust: TrustFile) {
  await withStoreLock(TRUST_FILE, () => writeAtomic(TRUST_FILE, trust));
}

async function approveProject(file: string, hash: string) {
  const trust = await readTrust();
  // The key is the file path, not the remote: two checkouts of one repo have different
  // files and must not inherit each other's approval.
  trust.projects[file] = { hash, approvedAt: now() };
  await writeTrust(trust);
}

async function loadLayer(cwd: string): Promise<ShelfLayer> {
  const collection = await loadCollection();
  const rules = await readRules();
  const root = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { collection, rules, project: null, projectFile: null, remote: "", root: null, remoteBlocked: false, trustBlocked: null, corrupt: firstCorrupt() };
  const remote = normalizeRemote(await gitText(root, ["remote", "get-url", "origin"]));
  const projectFile = join(root, ".pi", "shelf.json");
  try {
    const text = await readFile(projectFile, "utf8");
    const parsed = JSON.parse(text) as ProjectShelf;
    const fileRemote = typeof parsed.remote === "string" ? parsed.remote : "";
    if (!projectFileUsable(fileRemote, remote)) {
      return { collection, rules, project: null, projectFile, remote, root, remoteBlocked: true, trustBlocked: null, corrupt: firstCorrupt() };
    }
    const hash = hashText(text);
    const trust = await readTrust();
    const state = trustState(trust.projects[projectFile]?.hash, hash);
    if (state === "first-seen") {
      // TOFU: the first version of a project file is adopted without a prompt. Only a
      // later change is suspicious, because that is what a pulled commit would do.
      await approveProject(projectFile, hash);
    }
    const blocked = state === "changed" ? { hash, approved: trust.projects[projectFile]?.hash ?? "" } : null;
    return {
      collection,
      rules,
      project: {
        version: 1,
        remote: remote || fileRemote,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        archive: Array.isArray(parsed.archive) ? parsed.archive : [],
        topics: Array.isArray(parsed.topics) ? parsed.topics : [],
        // Sources and value providers run commands, so a changed file suspends both
        // until /shelf trust re-approves it.
        sources: blocked ? [] : Array.isArray(parsed.sources) ? parsed.sources : [],
        values: blocked ? [] : Array.isArray(parsed.values) ? parsed.values : [],
      },
      projectFile,
      remote,
      root,
      remoteBlocked: false,
      trustBlocked: blocked,
      corrupt: firstCorrupt(),
    };
  } catch (error) {
    parseFailure(projectFile, error);
    return { collection, rules, project: null, projectFile, remote, root, remoteBlocked: false, trustBlocked: null, corrupt: firstCorrupt() };
  }
}

let warnedTrust = false;

function warnTrust(ctx: ShelfCtx, layer: ShelfLayer) {
  if (!layer.trustBlocked || warnedTrust) return;
  warnedTrust = true;
  ctx.ui.notify(
    `${layer.projectFile} 自上次批准后已改动：项目里的动态源和变量 provider 已暂停。确认用 /shelf trust。`,
    "warning",
  );
}

function firstCorrupt() {
  return corrupt.values().next().value ?? null;
}

function rulesOf(layer: ShelfLayer) {
  const projectRules = layer.project
    ? { version: 1 as const, topics: layer.project.topics, sources: layer.project.sources, values: layer.project.values, aliases: [] }
    : emptyRules();
  return mergeRules(layer.rules, projectRules);
}

function itemsOf(layer: ShelfLayer) {
  return mergeItems(layer.collection.items, layer.project?.items ?? []);
}

async function readDiskCollection(): Promise<Collection> {
  try {
    return splitLegacy(JSON.parse(await readFile(STORE, "utf8"))).collection;
  } catch {
    return emptyCollection();
  }
}

async function readDiskRules(): Promise<Rules> {
  try {
    const parsed = JSON.parse(await readFile(RULES_FILE, "utf8")) as Rules;
    return {
      version: 1,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      values: Array.isArray(parsed.values) ? parsed.values : [],
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
    };
  } catch {
    return emptyRules();
  }
}

async function saveCollection(collection: Collection) {
  refuseOverwrite(STORE);
  await withStoreLock(STORE, async () => {
    // Re-read under the lock: another Pi window may have added an entry since our load.
    const merged = mergeCollection(await readDiskCollection(), collection);
    await writeAtomic(STORE, merged);
    collection.items = merged.items;
    collection.archive = merged.archive;
  });
}

async function saveRules(rules: Rules) {
  forgetStored();
  refuseOverwrite(RULES_FILE);
  await withStoreLock(RULES_FILE, async () => {
    const merged = mergeRules(await readDiskRules(), rules);
    // Aliases are global-only and the memory copy is the authority: merging the disk
    // list would resurrect a just-deleted alias.
    merged.aliases = rules.aliases;
    await writeAtomic(RULES_FILE, merged);
    rules.topics = merged.topics;
    rules.sources = merged.sources;
    rules.values = merged.values;
    rules.aliases = merged.aliases;
  });
}

async function saveProject(layer: ShelfLayer) {
  const file = layer.projectFile;
  if (!file || !layer.root) return;
  layer.project ??= emptyProject(layer.remote);
  layer.project.remote = layer.remote || layer.project.remote;
  refuseOverwrite(file);
  await withStoreLock(file, async () => {
    let disk: ProjectShelf | null = null;
    try {
      disk = JSON.parse(await readFile(file, "utf8")) as ProjectShelf;
    } catch {
      disk = null;
    }
    const merged = disk ? mergeProject(disk, layer.project!) : layer.project!;
    await writeAtomic(file, merged);
    layer.project!.items = merged.items;
    layer.project!.archive = merged.archive;
  });
  // Our own write is the new approved version; otherwise every edit would trip the
  // change detector on the next open.
  await approveProject(file, hashText(jsonText(layer.project!)));
}

// Overloaded so a literal scope narrows the result: project rules live on ProjectShelf
// and global rules on Collection, and only one of them has topics/sources.
function bagFor(layer: ShelfLayer, scope: "project"): ProjectShelf;
function bagFor(layer: ShelfLayer, scope: "global"): Collection;
function bagFor(layer: ShelfLayer, scope: Scope): Collection | ProjectShelf;
function bagFor(layer: ShelfLayer, scope: Scope) {
  if (scope === "project") {
    layer.project ??= emptyProject(layer.remote);
    return layer.project;
  }
  return layer.collection;
}

let storedCache: { at: number; key: string; trusted: boolean; items: Row[] } | null = null;

function forgetStored() {
  storedCache = null;
}

async function storedItems(cwd: string, trusted: boolean) {
  if (storedCache && storedCache.key === cwd && storedCache.trusted === trusted && Date.now() - storedCache.at < 1500) {
    return storedCache.items;
  }
  const items = [...itemsOf(await loadLayer(cwd)), ...(await promptFileRows(cwd, trusted))];
  storedCache = { at: Date.now(), key: cwd, trusted, items };
  return items;
}

async function saveScope(layer: ShelfLayer, scope: Scope) {
  forgetStored();
  if (scope === "project") await saveProject(layer);
  else await saveCollection(layer.collection);
}

const warnedCorrupt = new Set<string>();

/** A shelf file that failed to parse must never look like an empty shelf without a word. */
function warnCorrupt(ctx: ShelfCtx, layer: ShelfLayer) {
  if (!layer.corrupt || warnedCorrupt.has(layer.corrupt)) return;
  warnedCorrupt.add(layer.corrupt);
  ctx.ui.notify(`${layer.corrupt} 不是有效 JSON：已按空架子显示，并且不会再写回它。修好或移走后重试。`, "error");
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
  for (const call of shellPlan(process.platform, source.command, cwd)) {
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

async function promptFileRows(cwd: string, trusted: boolean): Promise<Row[]> {
  const places = [
    { dir: join(getAgentDir(), "prompts"), scope: "global" as const },
    // Pi gates project-local prompts behind project trust; a cloned repo must not feed
    // .pi/prompts into this session just because a shelf lookup ran.
    ...(trusted ? [{ dir: join(cwd, ".pi", "prompts"), scope: "project" as const }] : []),
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

async function rows(ctx: ShelfCtx, layer: ShelfLayer, cwd: string): Promise<Row[]> {
  warnTrust(ctx, layer);
  const trusted = projectTrusted(ctx);
  // Project rules can carry shell commands, so they only run when Pi trusts this project.
  const sources = trusted ? rulesOf(layer).sources : layer.rules.sources;
  if (!trusted && (layer.project?.sources.length ?? 0) > 0) warnUntrusted(ctx);
  const dynamic = (await Promise.all(sources.map((source) => runSource(source, cwd)))).flat();
  return [...itemsOf(layer), ...dynamic, ...(await promptFileRows(cwd, trusted))];
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


type ProviderCacheEntry = { at: number; lines: string[]; failed: boolean };
const providerCache = new Map<string, ProviderCacheEntry>();
const PROVIDER_TTL = 10_000;
const PROVIDER_FAIL_TTL = 20_000;

/**
 * Run a named value provider and split its stdout into candidate values. This runs the
 * user's own command, exactly like a dynamic source; project-scoped providers are only
 * reachable when Pi trusts the repo and the file hash is approved.
 */
async function runProvider(provider: ValueProvider, cwd: string): Promise<string[]> {
  const key = `${provider.id}\n${provider.command}\n${cwd}`;
  const cached = providerCache.get(key);
  if (cached && Date.now() - cached.at < (cached.failed ? PROVIDER_FAIL_TTL : PROVIDER_TTL)) {
    if (cached.failed) return [];
    return cached.lines;
  }
  for (const call of shellPlan(process.platform, provider.command, cwd)) {
    try {
      const { stdout } = await execFileAsync(call.command, call.args, {
        cwd,
        timeout: 4000,
        maxBuffer: 128_000,
        windowsHide: true,
      });
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 50);
      providerCache.set(key, { at: Date.now(), lines, failed: false });
      return lines;
    } catch {
      continue;
    }
  }
  providerCache.set(key, { at: Date.now(), lines: [], failed: true });
  return [];
}

function providerResolver(ctx: ShelfCtx, layer: ShelfLayer, cwd: string) {
  // Untrusted repos fall back to global providers only, mirroring how project sources
  // are skipped before Pi's trust decision.
  const values = projectTrusted(ctx) ? rulesOf(layer).values : layer.rules.values;
  const known = new Map(values.map((value) => [value.id.toLowerCase(), value]));
  return async (id: string) => {
    const provider = known.get(id.toLowerCase());
    if (!provider) return undefined;
    return runProvider(provider, cwd);
  };
}

async function expandTemplate(
  ctx: ShelfCtx,
  value: string,
  args: string[] = [],
  positional = false,
  providers?: (id: string) => Promise<string[] | undefined>,
): Promise<string | undefined> {
  // $1 and $@ mean Pi template arguments in a prompt and shell arguments in a command.
  // Expanding them in an ordinary entry rewrites the user's data (awk fields, quoted $@,
  // shell parameter expansions), so the caller has to say the row is a prompt first.
  const prepared = positional ? applyPositionals(value, args) : value;
  const slots = templateSlots(prepared);
  if (!slots.length) return prepared;
  const values: Record<string, string> = {};
  for (const slot of slots) {
    let options = [...slot.choices];
    if (slot.provider && providers) {
      const supplied = await providers(slot.provider);
      if (supplied?.length) options = supplied;
      else {
        ctx.ui.notify(`变量 ${slot.name} 的 provider ${slot.provider} 没有结果，改成手动输入。`, "warning");
      }
    }
    if (slot.fallback && !options.includes(slot.fallback)) options.unshift(slot.fallback);
    let answer: string | undefined;
    if (options.length) {
      const picked = await ctx.ui.select(`填写 {{${slot.name}}}`, [...options, "自己输入"]);
      if (picked == null) return;
      // Match against the offered choices, so a choice literally named 自己输入 still works.
      answer = options.includes(picked) ? picked : await askDefault(ctx, slot.name, slot.fallback);
    } else {
      answer = await askDefault(ctx, `填写 {{${slot.name}}}`, slot.fallback);
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
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const next = await expandTemplate(ctx, current, [], false, providerResolver(ctx, layer, ctx.cwd ?? process.cwd()));
  if (next == null) return;
  if (ctx.ui.setEditorText) ctx.ui.setEditorText(next);
  else ctx.ui.notify(next, "info");
}

async function promptContextText(ctx: ShelfCtx) {
  const cwd = ctx.cwd ?? process.cwd();
  // getSessionsDir() is not part of the package's public exports; the agent dir is.
  const dir = join(getAgentDir(), "sessions", sessionFolder(cwd));
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
    // fd prints directories with a trailing separator on Windows ("src\\"), so normalize
    // to relative forward-slash paths without one before any caller ranks or displays them.
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replaceAll("\\", "/").replace(/\/+$/, ""))
      .filter(Boolean);
    if (lines.length) return lines.slice(0, 4000);
  } catch {
    // fd is optional
  }
  return walkPaths(cwd, kind, 4);
}

async function fuzzyDirItems(cwd: string, query: string) {
  return (await listPaths(cwd, "dir"))
    .map((path) => ({ path, rank: rankPath(path, query) }))
    .filter((hit) => hit.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
    .slice(0, 30)
    .map((hit) => ({ value: `${hit.path}/`, label: `${hit.path.split("/").pop() ?? hit.path}/` }));
}

async function insertPath(ctx: ShelfCtx, kind: "dir" | "file") {
  const draft = ctx.ui.getEditorText?.() ?? "";
  const token = pathToken(draft);
  const seed = token.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const queryText = await askDefault(ctx, kind === "dir" ? "模糊目录，回车插回当前输入" : "模糊文件，回车插回当前输入", seed);
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

async function upsert(layer: ShelfLayer, draft: { category: string; title: string; value: string; tags?: string[]; aliases?: string[]; source?: Item["source"] }, scope: Scope, ctx?: ShelfCtx) {
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
    existing.aliases = [...new Set([...(existing.aliases ?? []), ...(draft.aliases ?? [])])];
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
    aliases: [...new Set((draft.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))],
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
  const prompts = (await rows(ctx, layer, ctx.cwd ?? process.cwd())).filter(isPromptRow);
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
      const list = choices(matched.slice(0, 30), (hit) => label(hit.item));
      row = list.pick(await ctx.ui.select("选择提示词", list.options))?.item;
    }
  }
  if (!row) {
    ctx.ui.notify(`没有名为 ${name} 的提示词。`, "warning");
    return;
  }
  const text = await expandTemplate(ctx, row.value, given, true, providerResolver(ctx, layer, ctx.cwd ?? process.cwd()));
  if (text == null) return;
  insertValue(ctx, text);
  ctx.ui.notify(`已插入输入框：${text}`, "info");
}


/**
 * Self-check, the way `murmo doctor` does it: one line per check, and the checks include
 * the failure modes that otherwise show up as "my entries disappeared".
 */
async function doctor(ctx: ShelfCtx, layer: ShelfLayer) {
  const lines: string[] = [];
  const file = async (path: string, label: string) => {
    try {
      const info = await stat(path);
      let parsed = "";
      if (path.endsWith(".json")) {
        try {
          JSON.parse(await readFile(path, "utf8"));
          parsed = " JSON 有效";
        } catch (error) {
          parsed = ` JSON 无效：${(error as Error).message}`;
        }
      }
      lines.push(`OK    ${label}  ${path}  ${info.size} B${parsed}`);
    } catch {
      lines.push(`--    ${label}  ${path}  不存在`);
    }
  };
  await file(STORE, "全局收藏");
  await file(RULES_FILE, "全局规则");
  if (layer.projectFile) await file(layer.projectFile, "仓库架子");
  else lines.push("--    仓库架子  当前目录不是 git 仓库");
  lines.push(`OK    写入目标  ${SHELF_DIR}`);
  lines.push(`${projectTrusted(ctx) ? "OK" : "WARN"}    仓库信任  ${projectTrusted(ctx) ? "已信任，项目 prompts 与动态源生效" : "未信任，已跳过项目 prompts 与动态源"}`);
  if (layer.remoteBlocked) lines.push(`WARN  remote 不匹配  ${layer.projectFile} 属于别的仓库，不会读写`);
  if (layer.trustBlocked) {
    lines.push(`WARN  项目文件已变更  ${layer.projectFile}  已批准 ${layer.trustBlocked.approved.slice(0, 8)} → 现在 ${layer.trustBlocked.hash.slice(0, 8)}（/shelf trust 重新批准）`);
  } else if (layer.projectFile) {
    const approved = (await readTrust()).projects[layer.projectFile];
    lines.push(`OK    项目文件批准  ${approved ? approved.hash.slice(0, 8) + " · " + approved.approvedAt.slice(0, 10) : "未记录"}`);
  }
  if (layer.corrupt) lines.push(`ERR   损坏文件  ${layer.corrupt}（已拒绝写入，先修好或移走）`);
  lines.push(`OK    条目数  全局 ${layer.collection.items.length} / 仓库 ${layer.project?.items.length ?? 0} / 归档 ${layer.collection.archive.length + (layer.project?.archive.length ?? 0)}`);
  lines.push(`OK    动态源  ${rulesOf(layer).sources.length} 个，topic ${rulesOf(layer).topics.length} 个，缩写 ${rulesOf(layer).aliases.length} 条`);
  try {
    const report = JSON.parse(await readFile(DIAGNOSTICS_FILE, "utf8")) as { checkedAt?: string; results?: Array<{ ok?: boolean }> };
    const results = Array.isArray(report.results) ? report.results : [];
    const dead = results.filter((result) => result.ok === false).length;
    lines.push(`OK    死链报告  ${(report.checkedAt ?? "").slice(0, 10)} 检查 ${results.length} 条，失败 ${dead} 条`);
  } catch {
    lines.push("--    死链报告  还没跑过 /shelf check");
  }
  try {
    const stats = parseCompletionStats(JSON.parse(await readFile(COMPLETIONS_FILE, "utf8")));
    const prefixes = Object.keys(stats.tokens).length;
    const values = Object.values(stats.tokens).reduce((sum, group) => sum + Object.keys(group).length, 0);
    lines.push(`OK    补全统计  ${prefixes} 个前缀 / ${values} 个候选`);
  } catch {
    lines.push("--    补全统计  还没记录");
  }
  lines.push(`OK    Pi agent 目录  ${getAgentDir()}`);
  if (process.env.PI_CODING_AGENT_DIR) lines.push(`OK    环境变量  PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`);
  ctx.ui.notify(lines.join("\n"), layer.corrupt ? "error" : "info");
}


/**
 * Approve the current bytes of .pi/shelf.json. Commands in that file (dynamic sources and
 * variable providers) only run while the hash matches the approved one, so a pulled
 * commit cannot add a command that executes on the next pick.
 */
async function trustFlow(ctx: ShelfCtx, layer: ShelfLayer) {
  if (!layer.projectFile) {
    ctx.ui.notify("当前目录不是 git 仓库，没有项目文件要批准。", "info");
    return;
  }
  let text = "";
  try {
    text = await readFile(layer.projectFile, "utf8");
  } catch {
    ctx.ui.notify("这个仓库还没有 .pi/shelf.json。", "info");
    return;
  }
  const hash = hashText(text);
  const trust = await readTrust();
  const approved = trust.projects[layer.projectFile];
  let parsed: ProjectShelf;
  try {
    parsed = JSON.parse(text) as ProjectShelf;
  } catch (error) {
    ctx.ui.notify(`.pi/shelf.json 不是有效 JSON：${(error as Error).message}`, "error");
    return;
  }
  const commands = [
    ...(Array.isArray(parsed.sources) ? parsed.sources : []).map((source) => `动态源 @${source.category}：${source.command}`),
    ...(Array.isArray(parsed.values) ? parsed.values : []).map((value) => `变量 ${value.id}：${value.command}`),
  ];
  if (!commands.length) {
    ctx.ui.notify("这份项目文件里没有会执行命令的条目，不需要批准。", "info");
    return;
  }
  const body = [
    layer.projectFile,
    `已批准 ${approved ? approved.hash.slice(0, 8) : "无"} → 当前 ${hash.slice(0, 8)}`,
    "",
    "批准后会执行：",
    ...commands.slice(0, 12),
    commands.length > 12 ? `…另有 ${commands.length - 12} 条` : "",
  ].join("\n");
  const choice = await ctx.ui.select(body, ["取消", "批准并启用"]);
  if (choice !== "批准并启用") return;
  await approveProject(layer.projectFile, hash);
  ctx.ui.notify(`已批准 ${layer.projectFile}（${hash.slice(0, 8)}），项目命令恢复。`, "info");
}

/**
 * The TUI path: one screen, live filter, preview. Anything that cannot host a custom
 * component (RPC, print, a host that rejects it) falls back to the two-dialog flow.
 */
async function chooseRow(ctx: ShelfCtx, candidates: Row[], initial: string, multi = true): Promise<Row[]> {
  if (ctx.mode === "tui" && ctx.ui.custom) {
    try {
      const picked = await ctx.ui.custom<Row[]>((tui, theme, _keybindings, done) =>
        createPicker(tui, theme, { rows: candidates, initial, multi }, done),
      );
      return picked ?? [];
    } catch {
      // fall through to the classic dialogs
    }
  }
  const queryText = await askDefault(ctx, "筛选：@类  #标签  关键字（可叠加）", initial);
  if (queryText == null) return [];
  const matched = rankRows(candidates, queryText, 30);
  if (!matched.length) {
    ctx.ui.notify("没有匹配。/shelf add 新增，或放宽标签。", "warning");
    return [];
  }
  const list = choices(matched, (hit) => label(hit.row));
  const row = list.pick(
    await ctx.ui.select(`架子（${matched.length}）  回车插入输入框  ${queryText || "全部"}`, list.options),
  )?.row;
  return row ? [row] : [];
}

/** Usage is not an edit: bumping `updated` here would make "recently changed" mean "recently pasted". */
async function recordUse(layer: ShelfLayer, row: Row) {
  if (row.dynamic || !row.scope) return;
  const bag = bagFor(layer, row.scope);
  const stored = bag.items.find((item) => item.id === row.id);
  if (!stored) return;
  stored.uses += 1;
  stored.lastUsed = now();
  await saveScope(layer, row.scope);
}

async function pick(ctx: ShelfCtx, initial = "", onlyTemplates = false) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  warnCorrupt(ctx, layer);
  const candidates = (await rows(ctx, layer, ctx.cwd ?? process.cwd())).filter(
    (row) => !onlyTemplates || isPromptRow(row),
  );
  if (!candidates.length) {
    ctx.ui.notify(onlyTemplates ? "还没有提示词。用 /shelf prompt add 新建。" : "架子是空的。/shelf add 新增。", "warning");
    return;
  }
  const chosen = await chooseRow(ctx, candidates, initial);
  if (!chosen.length) return;
  const resolver = providerResolver(ctx, layer, ctx.cwd ?? process.cwd());
  const parts: Part[] = [];
  for (const row of chosen) {
    const text = await expandTemplate(ctx, row.value, [], isPromptRow(row), resolver);
    // One cancelled variable cancels the whole insertion; a half-filled template is worse
    // than none.
    if (text == null) return;
    parts.push({ text, placement: row.placement, order: row.order });
  }
  let composed = composeParts(parts);
  if (chosen.length > 1) {
    const preview = await ctx.ui.editor?.( `组合预览：${chosen.length} 条（可直接改，回车插入）`, composed);
    if (preview == null) return;
    composed = preview;
  }
  // Usage is recorded only once the text actually reaches the editor; a cancelled
  // preview must not count as a use.
  for (const row of chosen) await recordUse(layer, row);
  insertValue(ctx, composed);
  ctx.ui.notify(`已插入输入框：${composed}`, "info");
}

async function addFlow(ctx: ShelfCtx, presetCategory = "") {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  warnCorrupt(ctx, layer);
  const category = await askDefault(ctx, "类别", presetCategory || "GitHub");
  if (!category) return;
  const title = await ctx.ui.input("标题");
  if (!title) return;
  // A prompt template is usually several lines; ui.input is single-line and would make
  // multi-line templates impossible to create from the UI.
  const value = category.toLowerCase() === "prompt" && ctx.ui.editor
    ? await ctx.ui.editor("模板。变量写成 {{name}} 或 {{name:甲|乙}}")
    : await ctx.ui.input(category.toLowerCase() === "prompt" ? "模板。变量写成 {{name}} 或 {{name:甲|乙}}" : "插入内容（URL / 命令 / 笔记）");
  if (!value) return;
  const tags = await ctx.ui.input("标签，空格分隔");
  const scope = await askScope(ctx, layer, "存到哪里");
  if (!scope) return;
  const item = await upsert(layer, { category, title, value, tags: (tags ?? "").split(/[\s,]+/), source: "manual" }, scope, ctx);
  ctx.ui.notify(`已保存到${scope === "project" ? "仓库" : "全局"} @${item.category} ${item.title}`, "info");
}

async function editItem(ctx: ShelfCtx, layer: ShelfLayer, item: ScopedItem) {
  const bag = bagFor(layer, item.scope);
  const stored = bag.items.find((entry) => entry.id === item.id);
  if (!stored) return;
  const title = await askText(ctx, "标题", stored.title);
  const value = await askText(ctx, "插入内容", stored.value);
  const tags = await askText(ctx, "标签", stored.tags.join(" "));
  const category = await askText(ctx, "类别", stored.category);
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
  if (!(await confirmDestructive(ctx, `归档 @${item.category} ${item.title}？`, "归档", "/shelf restore 可以恢复"))) return;
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
  const list = choices(archived, (item) => `${item.scope === "project" ? "仓库" : "全局"}  ${label(item)}`);
  const item = list.pick(await ctx.ui.select("恢复", list.options));
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
  const list = choices(items, label);
  return list.pick(await ctx.ui.select(title, list.options));
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
  } else if (topic !== "all" && ![...BUILTIN_TOPICS, ...rules.topics.map((item) => item.id.toLowerCase())].includes(topic)) {
    const msg = `未知 topic：${topicArg}。可用 ${knownTopics(rules).join("、")}。`;
    ctx.ui.notify(msg, "warning");
    return msg;
  }
  const hits = topic && topic !== "all" ? all.filter((hit) => hit.topic === topic) : all;
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
      const ok = await ctx.ui.confirm(`并入 @${hit.category} ${hit.title}`, `${hit.value}\n出现 ${hit.n} 次`);
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
  const category = await askDefault(ctx, "入库类别", id || "Note");
  const tags = await askDefault(ctx, "标签，空格分隔", id ?? "");
  const pattern = await askDefault(ctx, "正则。第 1 组是插入值，第 2 组可选作标题", id ? `${id}-\\d+` : "");
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
  const category = await askDefault(ctx, "动态源类别", "GitHub");
  const sample = process.platform === "win32" ? "Get-ChildItem -Name" : "git remote -v";
  const command = await askDefault(ctx, "命令。每行 标题<TAB>值。Windows 默认 PowerShell，也可写 cmd: 或 bash:", sample);
  const tags = await askDefault(ctx, "标签", "dynamic");
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
  const list = choices(entries, topicLabel);
  const topic = list.pick(await ctx.ui.select(action === "编辑" ? "编辑 topic" : "删除 topic", list.options));
  if (!topic) return;
  const project = topic.scope === "project";
  if (action === "删除") {
    if (!(await confirmDestructive(ctx, `删除 topic ${topic.id}？`, "删除"))) return;
    if (project) layer.project!.topics = layer.project!.topics.filter((item) => item.id !== topic.id);
    else layer.rules.topics = layer.rules.topics.filter((item) => item.id !== topic.id);
    if (project) await saveProject(layer);
    else await saveRules(layer.rules);
    ctx.ui.notify(`已删除 topic ${topic.id}`, "info");
    return;
  }
  const category = await askText(ctx, "入库类别", topic.category);
  const tags = await askText(ctx, "标签，空格分隔", topic.tags.join(" "));
  const pattern = await askText(ctx, "正则", topic.pattern);
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
  const list = choices(entries, sourceLabel);
  const source = list.pick(await ctx.ui.select(action === "编辑" ? "编辑动态源" : "删除动态源", list.options));
  if (!source) return;
  const project = source.scope === "project";
  if (action === "删除") {
    if (!(await confirmDestructive(ctx, `删除动态源 ${source.command}？`, "删除"))) return;
    if (project) layer.project!.sources = layer.project!.sources.filter((item) => item.id !== source.id);
    else layer.rules.sources = layer.rules.sources.filter((item) => item.id !== source.id);
    if (project) await saveProject(layer);
    else await saveRules(layer.rules);
    ctx.ui.notify("已删除动态源", "info");
    return;
  }
  const category = await askText(ctx, "类别", source.category);
  const command = await askText(ctx, "命令", source.command);
  const tags = await askText(ctx, "标签", source.tags.join(" "));
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


function valueEntries(layer: ShelfLayer) {
  return [
    ...layer.rules.values.map((value) => ({ ...value, scope: "global" as const })),
    ...(layer.project?.values ?? []).map((value) => ({ ...value, scope: "project" as const })),
  ];
}

function valueLabel(value: ValueProvider & { scope: Scope }) {
  return `${value.scope === "project" ? "仓库" : "全局"}  ${value.id}  ${value.command}`;
}

async function addValue(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const id = await askDefault(ctx, "变量名。模板里写 {{name=@这个id}}", "branch");
  if (!id) return;
  const command = await askDefault(ctx, "命令。每行一个候选值", "git branch --format=%(refname:short)");
  if (!command) return;
  const scope = await askScope(ctx, layer, "provider 存到哪里");
  if (!scope) return;
  const provider: ValueProvider = { id: id.trim(), command: command.trim() };
  if (scope === "project") {
    const project = layer.project ?? emptyProject(layer.remote);
    project.values = [...project.values.filter((value) => value.id.toLowerCase() !== provider.id.toLowerCase()), provider];
    layer.project = project;
    await saveProject(layer);
  } else {
    layer.rules.values = [...layer.rules.values.filter((value) => value.id.toLowerCase() !== provider.id.toLowerCase()), provider];
    await saveRules(layer.rules);
  }
  ctx.ui.notify(`已加变量 provider ${provider.id}，模板里用 {{名字=@${provider.id}}}。`, "info");
}

async function manageValues(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const action = await ctx.ui.select("变量 provider", ["新增", "编辑", "删除", "列出"]);
  if (action === "新增") return addValue(ctx);
  const entries = valueEntries(layer);
  if (action === "列出") {
    ctx.ui.notify(entries.map(valueLabel).join("\n") || "没有变量 provider。", "info");
    return;
  }
  if (action !== "编辑" && action !== "删除") return;
  if (!entries.length) {
    ctx.ui.notify("没有变量 provider。", "warning");
    return;
  }
  const list = choices(entries, valueLabel);
  const value = list.pick(await ctx.ui.select(action === "编辑" ? "编辑 provider" : "删除 provider", list.options));
  if (!value) return;
  const project = value.scope === "project";
  if (action === "删除") {
    if (!(await confirmDestructive(ctx, `删除 provider ${value.id}？`, "删除"))) return;
    if (project) layer.project!.values = layer.project!.values.filter((item) => item.id !== value.id);
    else layer.rules.values = layer.rules.values.filter((item) => item.id !== value.id);
    if (project) await saveProject(layer);
    else await saveRules(layer.rules);
    ctx.ui.notify(`已删除 provider ${value.id}`, "info");
    return;
  }
  const id = await askText(ctx, "变量名", value.id);
  const command = await askText(ctx, "命令", value.command);
  if (!id || !command) return;
  const next: ValueProvider = { id, command };
  const { scope: _scope, ...stored } = { ...next, scope: value.scope };
  if (project) {
    layer.project!.values = [...layer.project!.values.filter((item) => item.id !== value.id), stored];
    await saveProject(layer);
  } else {
    layer.rules.values = [...layer.rules.values.filter((item) => item.id !== value.id), stored];
    await saveRules(layer.rules);
  }
  ctx.ui.notify(`已更新 provider ${id}`, "info");
}


const HTTP_VALUE = /^https?:\/\//i;

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fill in a title and tags from the page itself, instead of making the user type them. */
async function enrichFlow(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  warnCorrupt(ctx, layer);
  const candidates = (await rows(ctx, layer, ctx.cwd ?? process.cwd())).filter(
    (row) => !row.dynamic && HTTP_VALUE.test(row.value),
  );
  if (!candidates.length) {
    ctx.ui.notify("没有可富化的链接条目。", "warning");
    return;
  }
  const [row] = await chooseRow(ctx, candidates, "", false);
  if (!row) return;
  if (!row.scope) {
    ctx.ui.notify("动态条目不能改写，先 /shelf pin。", "warning");
    return;
  }
  let found;
  try {
    found = await enrichUrl(row.value);
  } catch (error) {
    ctx.ui.notify(`抓取失败：${(error as Error).message.slice(0, 120)}`, "error");
    return;
  }
  if (!found.title && !found.tags.length) {
    ctx.ui.notify("没抓到标题或标签，保持原样。", "warning");
    return;
  }
  const item = await upsert(
    layer,
    {
      category: row.category,
      title: found.title ?? row.title,
      value: row.value,
      tags: [...row.tags, ...found.tags],
      source: row.source,
    },
    row.scope,
    ctx,
  );
  ctx.ui.notify(`已更新 ${item.title}${found.tags.length ? " #" + found.tags.join(" #") : ""}`, "info");
}

/** Check every saved link and keep the report outside the shelf files. */
async function checkFlow(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  warnCorrupt(ctx, layer);
  const all = itemsOf(layer).filter((item) => HTTP_VALUE.test(item.value));
  if (!all.length) {
    ctx.ui.notify("没有 http(s) 条目可检查。", "warning");
    return;
  }
  const unique = [...new Map(all.map((item) => [item.value, item])).values()];
  const results = await mapLimit(unique, 4, async (item) => ({
    id: item.id,
    title: item.title,
    value: item.value,
    ...(await checkUrl(item.value)),
  }));
  const dead = results.filter((result) => !result.ok);
  const unknown = results.filter((result) => result.ok && result.error);
  const report = { version: 1, checkedAt: now(), results };
  await withStoreLock(DIAGNOSTICS_FILE, () => writeAtomic(DIAGNOSTICS_FILE, report));
  const lines = [
    `检查 ${results.length} 条：${results.length - dead.length - unknown.length} 正常，${dead.length} 失败，${unknown.length} 未判定`,
    ...dead.slice(0, 8).map((result) => `✗ ${result.title}  ${result.status ?? result.error ?? ""}`),
    ...unknown.slice(0, 4).map((result) => `? ${result.title}  ${result.status ?? ""} ${result.error ?? ""}`),
    dead.length > 8 ? `…另有 ${dead.length - 8} 条失败，详见 ${DIAGNOSTICS_FILE}` : "",
  ].filter(Boolean);
  ctx.ui.notify(lines.join("\n"), dead.length ? "warning" : "info");
}


async function statsFlow(ctx: ShelfCtx, layer: ShelfLayer) {
  const all = itemsOf(layer);
  const used = all.filter((item) => item.uses > 0);
  const never = all.filter((item) => !item.uses);
  const top = [...used].sort((a, b) => b.uses - a.uses).slice(0, 5);
  let dead = 0;
  let checked = "";
  try {
    const report = JSON.parse(await readFile(DIAGNOSTICS_FILE, "utf8")) as { checkedAt?: string; results?: Array<{ ok?: boolean }> };
    dead = (report.results ?? []).filter((result) => result.ok === false).length;
    checked = (report.checkedAt ?? "").slice(0, 10);
  } catch {
    // no report yet
  }
  const lines = [
    `条目 ${all.length}（仓库 ${layer.project?.items.length ?? 0}）· 归档 ${layer.collection.archive.length + (layer.project?.archive.length ?? 0)}`,
    `用过 ${used.length} 条 · 从没用过 ${never.length} 条`,
    ...top.map((item) => `  ${item.uses}×  @${item.category}  ${item.title}`),
    dead || checked ? `死链 ${dead} 条（${checked || "未检查"}）` : "死链报告：还没跑过 /shelf check",
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}


type AliasDraft = { value: string; script?: AliasScript };

function aliasSummary(alias: Alias) {
  if (alias.script) return `${alias.key} → [脚本] ${alias.script.purpose}`;
  const flat = alias.value.replace(/\s+/g, " ").trim();
  return `${alias.key} → ${flat.length > 80 ? flat.slice(0, 79) + "…" : flat}`;
}

function stripCodeFence(text: string) {
  const fence = text.match(/^\s*```[A-Za-z]*\n([\s\S]*?)\n```\s*$/);
  return fence?.[1]?.trim() ?? text.trim();
}

async function generateAliasScript(ctx: ShelfCtx, purpose: string): Promise<string | undefined> {
  const runtime = (ctx as unknown as {
    model?: unknown;
    modelRegistry?: { complete?: (model: unknown, context: unknown, options?: unknown) => Promise<{ content?: Array<{ type: string; text?: string }> }> };
  });
  if (!runtime.model || !runtime.modelRegistry?.complete) {
    ctx.ui.notify("当前会话没有可用的模型运行时，无法生成脚本。", "error");
    return undefined;
  }
  const language = process.platform === "win32" ? "PowerShell" : "bash";
  try {
    const response = await runtime.modelRegistry.complete(
      runtime.model,
      {
        systemPrompt: `You write short ${language} scripts for a developer terminal. Output only the script, no markdown fences or commentary. The script runs in the project cwd and its stdout becomes inserted text.`,
        messages: [{ role: "user", content: [{ type: "text", text: purpose }], timestamp: Date.now() }],
      },
      { signal: AbortSignal.timeout(60_000) },
    );
    const text = (response.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    if (!text.trim()) {
      ctx.ui.notify("模型没有返回脚本。", "warning");
      return undefined;
    }
    return stripCodeFence(text);
  } catch (error) {
    ctx.ui.notify(`生成脚本失败：${(error as Error).message.slice(0, 120)}`, "error");
    return undefined;
  }
}

async function askAliasValue(ctx: ShelfCtx, layer: ShelfLayer, pi: ExtensionAPI, prefill = ""): Promise<AliasDraft | undefined> {
  const source = await ctx.ui.select("展开内容来源", ["手动输入（支持宏）", "从工具名选", "从收藏值选", "脚本（AI 生成）"]);
  if (!source) return undefined;
  if (source === "脚本（AI 生成）") {
    const purpose = await ctx.ui.editor?.("脚本目的（AI 生成后，展开时执行）", "");
    if (!purpose?.trim()) return undefined;
    const generated = await generateAliasScript(ctx, purpose.trim());
    if (generated === undefined) return undefined;
    const reviewed = await ctx.ui.editor?.("生成的脚本（可修改；展开时执行，stdout 作为展开文本）", generated);
    if (reviewed == null || !reviewed.trim()) return undefined;
    return {
      value: "",
      script: { language: process.platform === "win32" ? "powershell" : "bash", source: reviewed, purpose: purpose.trim() },
    };
  }
  if (source === "从工具名选") {
    const api = pi as ExtensionAPI & { getAllTools?: () => ToolLike[] };
    const tools = typeof api.getAllTools === "function" ? api.getAllTools().filter((tool) => tool.exposure !== "hidden") : [];
    if (!tools.length) {
      ctx.ui.notify("当前没有可选的工具。", "warning");
      return undefined;
    }
    if (ctx.mode === "tui" && ctx.ui.custom) {
      const rows: Row[] = tools.map((tool, index) => ({
        id: `tool:${tool.name}:${index}`,
        category: "工具",
        title: tool.name,
        value: tool.name,
        tags: tool.sourceInfo?.source === "builtin" ? ["内置"] : [],
        source: "manual",
        uses: 0,
        created: "",
        updated: "",
        dynamic: true,
      }));
      const selected = await ctx.ui.custom<Row[]>((tui, theme, _keybindings, done) =>
        createPicker(tui, theme, { rows, initial: "", multi: false }, done),
      );
      return selected[0]?.value ? { value: selected[0].value } : undefined;
    }
    const picked = await ctx.ui.select("选择工具名", tools.map((tool) => tool.name).sort());
    return picked ? { value: picked } : undefined;
  }
  if (source === "从收藏值选") {
    const entries = itemsOf(layer);
    if (!entries.length) {
      ctx.ui.notify("架子里还没有条目。", "warning");
      return undefined;
    }
    const list = choices(entries, (item) => `@${item.category}  ${item.title}`);
    const picked = list.pick(await ctx.ui.select("选择收藏值", list.options));
    return picked ? { value: picked.value } : undefined;
  }
  const entered = await ctx.ui.editor?.(`展开内容（可多行）。支持宏：${ALIAS_MACROS}`, prefill);
  if (entered == null) return undefined;
  if (!entered.trim()) {
    ctx.ui.notify("展开内容不能为空。", "warning");
    return undefined;
  }
  return { value: entered };
}

async function manageAliases(ctx: ShelfCtx, pi: ExtensionAPI) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  warnCorrupt(ctx, layer);
  const aliases = layer.rules.aliases;
  const action = await ctx.ui.select("自定义展开", ["列出", "新增", "更改", "删除"]);
  if (!action) return;
  if (action === "列出") {
    ctx.ui.notify(aliases.length ? aliases.map(aliasSummary).join("\n") : "没有自定义展开。", "info");
    return;
  }
  if (action === "新增") {
    const entered = await askDefault(ctx, "缩写（2–32 个字符，例如 ws）", "ws");
    const key = entered?.trim() ?? "";
    if (!key) return;
    if (!aliasKeyValid(key)) {
      ctx.ui.notify("缩写只能包含字母、数字、_ . : -，长度 2–32。", "warning");
      return;
    }
    if (aliases.some((alias) => alias.key.toLowerCase() === key.toLowerCase())) {
      if (!(await confirmDestructive(ctx, `${key} 已存在，覆盖它？`, "覆盖"))) return;
    }
    const draft = await askAliasValue(ctx, layer, pi);
    if (!draft) return;
    const alias: Alias = { key, value: draft.value, script: draft.script };
    layer.rules.aliases = [...aliases.filter((item) => item.key.toLowerCase() !== key.toLowerCase()), alias];
    await saveRules(layer.rules);
    const preview = draft.script ? `[脚本] ${draft.script.purpose}` : expandAlias(draft.value, { clipboard: await readClipboard() }).text;
    ctx.ui.notify(`已添加 ${aliasSummary({ ...alias, value: preview })}`, "info");
    return;
  }
  if (!aliases.length) {
    ctx.ui.notify("没有自定义展开。", "warning");
    return;
  }
  const indexed = aliases.map((alias, index) => ({ ...alias, index }));
  const list = choices(indexed, aliasSummary);
  const picked = list.pick(await ctx.ui.select(action === "更改" ? "更改哪一条" : "删除哪一条", list.options));
  if (!picked) return;
  if (action === "删除") {
    if (!(await confirmDestructive(ctx, `删除 ${picked.key}？`, "删除"))) return;
    layer.rules.aliases = aliases.filter((_, index) => index !== picked.index);
    await saveRules(layer.rules);
    ctx.ui.notify(`已删除 ${picked.key}`, "info");
    return;
  }
  const key = (await askDefault(ctx, "缩写", picked.key))?.trim() ?? "";
  if (!key || !aliasKeyValid(key)) {
    if (key) ctx.ui.notify("缩写只能包含字母、数字、_ . : -，长度 2–32。", "warning");
    return;
  }
  if (aliases.some((alias, index) => index !== picked.index && alias.key.toLowerCase() === key.toLowerCase())) {
    ctx.ui.notify(`${key} 已经被另一条缩写使用。`, "warning");
    return;
  }
  const draft = await askAliasValue(ctx, layer, pi, picked.script?.source ?? picked.value);
  if (!draft) return;
  layer.rules.aliases = [
    ...aliases.filter((alias, index) => index !== picked.index && alias.key.toLowerCase() !== key.toLowerCase()),
    { key, value: draft.value, script: draft.script },
  ];
  await saveRules(layer.rules);
  ctx.ui.notify(`已更新 ${key}`, "info");
}


function refRows(layer: ShelfLayer) {
  return itemsOf(layer).filter((row) => row.category.toLowerCase() === "ref");
}

function refLabel(row: Row) {
  return `${row.title}  →  ${row.value}`;
}

async function refFlow(ctx: ShelfCtx, layer: ShelfLayer, args: string) {
  const [subWord, ...rest] = splitArgs(args.trim());
  const sub = subWord?.toLowerCase();
  if (!sub || sub === "list") {
    const refs = refRows(layer);
    if (!refs.length) {
      ctx.ui.notify("还没有引用。用 /shelf ref add <url> 添加。", "info");
      return;
    }
    ctx.ui.notify(refs.map(refLabel).join("\n"), "info");
    return;
  }
  if (sub === "add") {
    let input = rest.join(" ").trim();
    if (!input) input = (await ctx.ui.input("仓库地址或 URL（例如 owner/repo 或 https://github.com/...）"))?.trim() ?? "";
    if (!input) return;
    const parsed = parseTarget(input);
    if (!parsed) {
      ctx.ui.notify("认不出这个地址。支持 owner/repo、GitHub URL、DOI、arXiv 或 http(s) URL。", "warning");
      return;
    }
    if (parsed.kind === "github" || parsed.kind === "doi" || parsed.kind === "arxiv") {
      try {
        const enriched = await enrichUrl(parsed.value);
        const item = await upsert(layer, {
          category: "Ref",
          title: parsed.label,
          value: parsed.value,
          tags: ["ref", parsed.kind, ...(enriched.tags ?? [])],
          aliases: [...parsed.aliases, ...(enriched.title ? [enriched.title] : [])],
        }, "global", ctx);
        ctx.ui.notify(`已添加 ${item.title}  →  ${item.value}`, "info");
        return;
      } catch {
        // metadata lookup is best effort; the exact URL is the important part
      }
    }
    const item = await upsert(layer, {
      category: "Ref",
      title: parsed.label,
      value: parsed.value,
      tags: ["ref", parsed.kind],
      aliases: parsed.aliases,
    }, "global", ctx);
    ctx.ui.notify(`已添加 ${item.title}  →  ${item.value}`, "info");
    return;
  }
  if (sub === "rm" || sub === "delete" || sub === "remove") {
    const refs = refRows(layer);
    const list = choices(refs, refLabel);
    const picked = list.pick(await ctx.ui.select("删除哪条引用", list.options));
    if (!picked) return;
    if (!(await confirmDestructive(ctx, `删除 ${picked.title}？`, "删除"))) return;
    const scope = picked.scope ?? "global";
    const bag = bagFor(layer, scope);
    bag.items = bag.items.filter((item) => item.id !== picked.id);
    await saveScope(layer, scope);
    ctx.ui.notify(`已删除 ${picked.title}`, "info");
    return;
  }
  // Anything else is a lookup: one exact hit inserts directly, several open a picker.
  const queryText = [sub, ...rest].join(" ").trim();
  const refs = refRows(layer);
  const matched = rankRows(refs, queryText, 30);
  const hits = rankTargets(refs, queryText, matched.map((hit) => hit.row));
  if (!hits.length) {
    ctx.ui.notify(`没有匹配的引用：${queryText}`, "warning");
    return;
  }
  if (hits.length === 1) {
    insertValue(ctx, hits[0]!.row.value);
    await recordUse(layer, hits[0]!.row);
    ctx.ui.notify(`已插入 ${hits[0]!.row.value}`, "info");
    return;
  }
  const list = choices(hits.map((hit) => hit.row), refLabel);
  const picked = list.pick(await ctx.ui.select(`选择引用（${hits.length}）`, list.options));
  if (!picked) return;
  insertValue(ctx, picked.value);
  await recordUse(layer, picked);
  ctx.ui.notify(`已插入 ${picked.value}`, "info");
}

async function pinDynamic(ctx: ShelfCtx) {
  const layer = await loadLayer(ctx.cwd ?? process.cwd());
  const dynamic = (await rows(ctx, layer, ctx.cwd ?? process.cwd())).filter((row) => row.dynamic);
  if (!dynamic.length) {
    ctx.ui.notify("没有动态条目。先 /shelf source。", "warning");
    return;
  }
  const list = choices(dynamic, label);
  const row = list.pick(await ctx.ui.select("钉住为永久条目", list.options));
  if (!row) return;
  const scope = await askScope(ctx, layer, "钉到哪里");
  if (!scope) return;
  await upsert(layer, { category: row.category, title: row.title, value: row.value, tags: row.tags, source: "pinned" }, scope, ctx);
  ctx.ui.notify(`已钉住 ${row.title}`, "info");
}

type CompleteItem = { value: string; label: string; description?: string; shelfKind?: "shelf" | "remote" | "tool" | "package" | "alias" | "script"; cursorOffset?: number; script?: AliasScript };

/** "-" and "_" are equivalent when deciding whether a candidate is a prefix hit. */
function sameStem(value: string, prefix: string) {
  const normalize = (text: string) => text.toLowerCase().replace(/[-_]+/g, "_");
  return normalize(value).startsWith(normalize(prefix));
}
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

// Listings are cached briefly so a keystroke does not start a new ssh session. Failures are
// cached too: without that, every keystroke on an unreachable host pays the connect timeout.
const remoteListings = new Map<string, { at: number; text: string; failed: boolean }>();
const REMOTE_CACHE_MS = 10_000;
const REMOTE_FAILURE_CACHE_MS = 20_000;
const REMOTE_CACHE_MAX = 64;

const SHELF_ACTIONS = [
  { value: "add", description: "新增收藏" },
  { value: "edit", description: "编辑收藏" },
  { value: "rm", description: "归档收藏" },
  { value: "restore", description: "恢复归档" },
  { value: "harvest", description: "收集会话条目" },
  { value: "topic", description: "管理自定义 topic" },
  { value: "source", description: "管理动态源" },
  { value: "pin", description: "钉住动态结果" },
  { value: "prompt", description: "使用提示词" },
  { value: "fill", description: "展开当前变量" },
  { value: "dir", description: "模糊选择目录" },
  { value: "file", description: "模糊选择文件" },
  { value: "list", description: "列出收藏" },
  { value: "export", description: "导出条目为 JSON" },
  { value: "import", description: "从 JSON 并入条目" },
  { value: "doctor", description: "检查存储、信任与配置" },
  { value: "trust", description: "批准项目文件（哈希）" },
  { value: "value", description: "管理变量 provider" },
  { value: "alias", description: "管理自定义展开（缩写→文本）" },
  { value: "ref", description: "管理仓库/链接引用" },
  { value: "enrich", description: "抓取链接标题与标签" },
  { value: "check", description: "检查失效链接" },
  { value: "stats", description: "使用统计" },
];

type CompletionMeta = CompleteItem & { completionKind?: "shelf-action" | "shelf-arg" };

function wordCompletions(entries: Array<{ value: string; label?: string; description?: string }>, prefix: string, completionKind: CompletionMeta["completionKind"]) {
  return entries
    .map((item) => ({ item, rank: fuzzy(item.value, prefix) }))
    .filter((hit) => hit.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.item.value.localeCompare(b.item.value))
    .map(({ item }) => ({ ...item, label: item.label ?? item.value, completionKind }));
}

async function shelfCommandSuggestions(context: ReturnType<typeof shelfCompletionContext>, cwd: string, trusted: boolean) {
  if (!context) return null;
  if (context.kind === "action") {
    const items = wordCompletions(SHELF_ACTIONS, context.prefix, "shelf-action");
    if (context.bare) return { items: items.map((item) => ({ ...item, value: "shelf " + item.value })), prefix: "/shelf" };
    return { items, prefix: context.prefix };
  }
  const layer = await loadLayer(cwd);
  if (context.kind === "topic") {
    const topics = [...new Set(knownTopics(rulesOf(layer)).map((topic) => topic.toLowerCase()))];
    return { items: wordCompletions(topics.map((topic) => ({ value: topic, description: "harvest topic" })), context.prefix, "shelf-arg"), prefix: context.prefix };
  }
  const prompts = (await storedItems(cwd, trusted)).filter(isPromptRow);
  const seen = new Set<string>();
  const entries = prompts.flatMap((row) => {
    const key = row.title.toLowerCase();
    if (!row.title || seen.has(key)) return [];
    seen.add(key);
    return [{ value: row.title, description: "@" + row.category + (row.scope === "project" ? " ·repo" : "") }];
  });
  return { items: wordCompletions(entries, context.prefix, "shelf-arg"), prefix: context.prefix };
}

function isDirectoryCompletionItem(item: CompleteItem) {
  return item.label.endsWith("/") || (item as CompleteItem & { isDirectory?: boolean }).isDirectory === true;
}

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
    const fromKnownHosts = parseKnownHosts(await readFile(join(dir, "known_hosts"), "utf8"));
    known.hosts.push(...fromKnownHosts.hosts);
    known.patterns.push(...fromKnownHosts.patterns);
  } catch {
    // no known hosts
  }
  return known;
}

async function remoteListing(destination: string, listDir: string, signal: AbortSignal) {
  const key = `${destination}\n${listDir}`;
  const cached = remoteListings.get(key);
  if (cached && Date.now() - cached.at < (cached.failed ? REMOTE_FAILURE_CACHE_MS : REMOTE_CACHE_MS)) {
    if (cached.failed) throw new Error("ssh listing unavailable");
    return cached.text;
  }
  try {
    const { stdout } = await execFileAsync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-o", "LogLevel=ERROR", destination, `ls -1Ap -- ${shQuote(listDir || ".")}`],
      { timeout: 5000, signal, maxBuffer: 200_000 },
    );
    remember(key, { at: Date.now(), text: stdout, failed: false });
    return stdout;
  } catch (error) {
    // A superseded request aborts; that is not evidence the host is unreachable.
    const aborted = signal.aborted || (error as { name?: string })?.name === "AbortError";
    if (!aborted) remember(key, { at: Date.now(), text: "", failed: true });
    throw error;
  }
}

function remember(key: string, entry: { at: number; text: string; failed: boolean }) {
  remoteListings.delete(key);
  remoteListings.set(key, entry);
  while (remoteListings.size > REMOTE_CACHE_MAX) {
    const oldest = remoteListings.keys().next().value;
    if (oldest === undefined) break;
    remoteListings.delete(oldest);
  }
}

async function loadCompletionStats(): Promise<CompletionStats> {
  try {
    return parseCompletionStats(JSON.parse(await readFile(COMPLETIONS_FILE, "utf8")));
  } catch {
    return emptyCompletionStats();
  }
}

function installAutocomplete(pi: ExtensionAPI) {
  let completionStats = emptyCompletionStats();
  let completionCtx: ShelfCtx | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleCompletionSave = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      // Stats are a convenience cache, not shelf data: a failed write must never break
      // the completion path.
      void withStoreLock(COMPLETIONS_FILE, () => writeAtomic(COMPLETIONS_FILE, completionStats)).catch(() => {});
    }, 300);
    flushTimer.unref?.();
  };
  // The tool registry is live: MCP servers connect and extensions register tools after
  // session_start, so this is read on every completion instead of captured once.
  // Package names are not part of ToolInfo, so they are resolved from the extension
  // source: "npm:@scope/pkg" directly, or the nearest package.json for a local checkout.
  const manifestCache = new Map<string, string | null>();
  const manifestName = (dir: string | undefined): string | undefined => {
    if (!dir) return undefined;
    let current = dir;
    for (let depth = 0; depth < 5; depth += 1) {
      const file = join(current, "package.json");
      if (manifestCache.has(file)) {
        const hit = manifestCache.get(file);
        if (hit) return hit;
      } else {
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown };
          const name = typeof parsed.name === "string" ? parsed.name : "";
          manifestCache.set(file, name || null);
          if (name) return name;
        } catch {
          manifestCache.set(file, null);
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  };
  const enrichTool = (tool: ToolLike): ToolLike => {
    const source = tool.sourceInfo?.source;
    if (source === "builtin" || source === "sdk") return tool;
    const identity = packageIdentity(source, tool.sourceInfo?.path, manifestName(tool.sourceInfo?.baseDir));
    return identity
      ? { ...tool, packageName: identity.name, packageFullName: identity.fullName, packageAliases: identity.aliases }
      : tool;
  };
  const aliasCandidates = async (ctx: ShelfCtx, prefix: string): Promise<CompleteItem[]> => {
    // Aliases are global rules, so a config read is enough; do not pay the git calls of
    // loadLayer on every Tab in an unrelated directory.
    const rules = await readRules();
    const matches = matchAliases(rules.aliases, prefix);
    if (!matches.length) return [];
    // Only touch the OS clipboard when an alias actually uses the macro; otherwise a
    // short alias list would pay a PowerShell/pbpaste round-trip on every Tab.
    const needsClipboard = matches.some(({ alias }) => alias.value.includes("{{clipboard}}"));
    const needsClipboardImage = matches.some(({ alias }) => alias.value.includes("{{clipboard-image}}"));
    const needsScreenshot = matches.some(({ alias }) => alias.value.includes("{{screenshot}}"));
    const clipboard = needsClipboard ? await readClipboard() : undefined;
    let clipboardImage: string | undefined;
    if (needsClipboardImage) {
      const image = await readClipboardImage();
      if (!image) {
        ctx.ui.notify("剪贴板里没有图片。", "warning");
        return [];
      }
      clipboardImage = await saveTempImage(image);
    }
    let screenshot: string | undefined;
    if (needsScreenshot) {
      const captured = await captureScreenshot();
      if (!captured) {
        ctx.ui.notify("截图取消或失败。", "warning");
        return [];
      }
      screenshot = captured;
    }
    const items: CompleteItem[] = [];
    for (const { alias } of matches) {
      if (alias.script) {
        // Do not execute while merely listing candidates: the script runs only when the
        // user actually accepts this row (applyCompletion is synchronous).
        items.push({
          value: "",
          label: `${alias.key} → [脚本] ${alias.script.purpose.slice(0, 40)}`,
          description: "脚本展开 · 选中后执行",
          shelfKind: "script" as const,
          script: alias.script,
        });
        continue;
      }
      const expanded = expandAlias(alias.value, { clipboard, clipboardImage, screenshot, env: process.env });
      const flat = expanded.text.replace(/\s+/g, " ").trim();
      items.push({
        value: expanded.text,
        label: `${alias.key} → ${flat.length > 44 ? flat.slice(0, 43) + "…" : flat}`,
        description: `自定义展开${expanded.cursorOffset !== undefined ? " · 光标定位" : ""}`,
        shelfKind: "alias" as const,
        cursorOffset: expanded.cursorOffset,
      });
    }
    return items;
  };
  const toolCandidates = (prefix: string): { tools: CompleteItem[]; packages: CompleteItem[] } => {
    const api = pi as ExtensionAPI & { getAllTools?: () => ToolLike[]; getActiveTools?: () => string[] };
    if (typeof api.getAllTools !== "function") return { tools: [], packages: [] };
    try {
      const active = typeof api.getActiveTools === "function" ? api.getActiveTools() : [];
      const tools = api.getAllTools().map(enrichTool);
      const usage = completionScores(completionStats, prefix);
      return {
        tools: rankTools(tools, prefix, active, 10, usage).map((tool) => ({
          value: tool.name,
          label: tool.name,
          description: tool.description,
          shelfKind: "tool" as const,
        })),
        packages: rankPackages(tools, prefix, usage).map((pkg) => ({
          value: pkg.name,
          label: pkg.name,
          description: [pkg.fullName, pkg.description].filter(Boolean).join(" · "),
          shelfKind: "package" as const,
        })),
      };
    } catch {
      return { tools: [], packages: [] };
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    completionCtx = ctx as ShelfCtx;
    completionStats = await loadCompletionStats();
    const known = await readSshHosts();
    const ui = ctx.ui as ShelfUi & {
      addAutocompleteProvider?: (factory: (current: CompleteProvider) => CompleteProvider) => void;
      onTerminalInput?: (handler: (data: string) => { data?: string } | undefined) => void;
    };
    ui.onTerminalInput?.((data) => {
      if (isAltSlash(data)) return { data: "\t" };
    });
    ui.addAutocompleteProvider?.((current) => ({
      // "_" is a natural trigger for tool names (web_, mcp__github__), so the list can
      // open without Tab. "-" is deliberately not a trigger: it matches "_" but only
      // completes on Tab/alt+/.
      triggerCharacters: [":", "@", "#", "_"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const interception = shelfInterceptionContext(before, options.force === true);
        if (interception.kind === "shelf-command") {
          const command = await shelfCommandSuggestions(interception.context, (ctx as ShelfCtx).cwd ?? process.cwd(), projectTrusted(ctx as ShelfCtx));
          if (command?.items.length) return command;
        }
        if (interception.kind === "foreign-slash") return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const addDirPath = interception.kind === "add-dir-path" ? interception.path : null;
        if (slashCommandToken(before)) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const token = parseRemoteToken(before);
        // "host:8080" is a port in prose, not a remote path. Only a forced Tab or a
        // path-like continuation (`host:dir/`) should reach ssh.
        const portLike = token !== null && token.displayDir === "" && /^\d{1,5}$/.test(token.namePrefix);
        if (token && !(portLike && options.force !== true) && hostAllowed(token.destination, known)) {
          try {
            const listing = await remoteListing(token.destination, token.listDir, options.signal);
            const items = remoteItems(token, remoteEntries(listing, token.namePrefix, {
              directoriesOnly: addDirPath !== null,
              fuzzy: options.force === true,
            })).map((item) => ({
              ...item,
              shelfKind: "remote" as const,
            }));
            if (items.length) return { items, prefix: token.prefix };
          } catch {
            return null;
          }
        }
        if (addDirPath !== null && isPathLikeToken(addDirPath)) {
          const local = await localDriveItems(addDirPath, { directoriesOnly: true, fuzzy: options.force === true });
          if (local?.length) return { items: local, prefix: addDirPath };
          const probe = addDirPath.startsWith("/") ? `x ${addDirPath}` : addDirPath;
          const delegated = await current.getSuggestions([probe], 0, probe.length, options);
          if (!delegated) return null;
          const items = delegated.items.filter(isDirectoryCompletionItem);
          return items.length ? { ...delegated, items, prefix: delegated.prefix || addDirPath } : null;
        }
        if (addDirPath !== null) {
          const dirs = await fuzzyDirItems((ctx as ShelfCtx).cwd ?? process.cwd(), addDirPath);
          if (dirs.length) return { items: dirs, prefix: addDirPath };
        }
        const path = pathToken(before);
        const local = path ? await localDriveItems(path, { fuzzy: options.force === true }) : null;
        if (local?.length) return { items: local, prefix: path };
        // Custom abbreviations only expand on an explicit completion key; "ws" in prose
        // must stay ordinary text.
        if (options.force === true) {
          const aliasPrefix = draftSeed(before);
          if (/^[A-Za-z0-9_.:-]{2,32}$/.test(aliasPrefix)) {
            const aliasItems = await aliasCandidates(ctx as ShelfCtx, aliasPrefix);
            if (aliasItems.length) {
              let native: { items: CompleteItem[]; prefix: string } | null = null;
              try {
                native = await current.getSuggestions(lines, cursorLine, cursorCol, options);
              } catch {
                native = null;
              }
              const items = native && native.prefix === aliasPrefix ? [...aliasItems, ...native.items] : aliasItems;
              return { items, prefix: aliasPrefix };
            }
          }
        }
        // Tool names come from Pi's live registry, never a hardcoded list. A token with
        // "_" (web_, mcp__github__) opens on its own; other tokens need Tab/Alt+/.
        const toolContext = toolToken(before, options.force === true);
        const toolFound = toolContext ? toolCandidates(toolContext.prefix) : { tools: [], packages: [] };
        const toolMatches = toolFound.tools;
        const packageMatches = toolFound.packages;
        const shelfQuery = interception.kind === "shelf-query" ? interception.query : null;
        if (shelfQuery) {
          const cwd = (ctx as ShelfCtx).cwd ?? process.cwd();
          const matches = shelfMatches(await storedItems(cwd, projectTrusted(ctx as ShelfCtx)), shelfQuery.seed, options.force === true);
          if (matches.length) {
            const shelfItems = matches.map((hit) => ({
              value: hit.row.value,
              label: hit.row.title,
              description: `@${hit.row.category}${templateSlots(hit.row.value).length ? " 模板" : ""}`,
              shelfKind: "shelf" as const,
            }));
            // Pi owns "@" attachments and Tab file completion for this same token, so keep
            // its candidates after the shelf hits rather than replacing them.
            let native: { items: CompleteItem[]; prefix: string } | null = null;
            try {
              native = await current.getSuggestions(lines, cursorLine, cursorCol, options);
            } catch {
              native = null;
            }
            // The tool list is a separate source: a saved entry and a tool can share a
            // token, so both stay available and each keeps its own label. A token that is
            // literally the start of a tool name puts tools first; otherwise saved entries
            // keep their usual priority.
            const tools = toolContext && toolContext.prefix === shelfQuery.seed ? toolMatches : [];
            const packages = toolContext && toolContext.prefix === shelfQuery.seed ? packageMatches : [];
            const toolFirst = tools.some((tool) => sameStem(tool.value, shelfQuery.seed));
            const packageFirst = packages.length > 0 && !toolFirst;
            const toolBlock = packageFirst ? [...packages, ...tools] : [...tools, ...packages];
            // A strong tool/plugin hit owns the token: the shelf entries that merely
            // mention the word in their body would otherwise bury the real candidates.
            const merged = toolFirst || packageFirst ? toolBlock : [...shelfItems, ...toolBlock];
            const items = native && native.prefix === shelfQuery.seed ? [...merged, ...native.items] : merged;
            return { items, prefix: shelfQuery.seed };
          }
        }
        if ((toolMatches.length || packageMatches.length) && toolContext) {
          let native: { items: CompleteItem[]; prefix: string } | null = null;
          try {
            native = await current.getSuggestions(lines, cursorLine, cursorCol, options);
          } catch {
            native = null;
          }
          const toolFirst = toolMatches.some((tool) => sameStem(tool.value, toolContext.prefix));
          const block = toolFirst || !packageMatches.length ? [...toolMatches, ...packageMatches] : [...packageMatches, ...toolMatches];
          const items = native && native.prefix === toolContext.prefix ? [...block, ...native.items] : block;
          return { items, prefix: toolContext.prefix };
        }
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const marked = item as CompletionMeta & { shelfKind?: string };
        // A tool name replaces the typed fragment and adds one space, the same rule the
        // shelf/remote insertions use.
        if (marked.shelfKind === "script" && item.script) {
          try {
            const output = runAliasScriptSync(item.script, completionCtx?.cwd ?? process.cwd());
            if (!output.trim()) {
              completionCtx?.ui.notify("脚本没有输出，未插入。", "warning");
              return { lines, cursorLine, cursorCol };
            }
            recordCompletion(completionStats, prefix, output);
            scheduleCompletionSave();
            return applyRemoteCompletion(lines, cursorLine, cursorCol, output, prefix, false);
          } catch (error) {
            completionCtx?.ui.notify(`脚本运行失败：${(error as Error).message.slice(0, 120)}`, "error");
            return { lines, cursorLine, cursorCol };
          }
        }
        if (marked.shelfKind === "alias") {
          recordCompletion(completionStats, prefix, item.value);
          scheduleCompletionSave();
          return applyRemoteCompletion(lines, cursorLine, cursorCol, item.value, prefix, false, item.cursorOffset);
        }
        if (marked.shelfKind === "tool" || marked.shelfKind === "package") {
          recordCompletion(completionStats, prefix, item.value);
          scheduleCompletionSave();
          return applyRemoteCompletion(lines, cursorLine, cursorCol, item.value, prefix, false);
        }
        if (marked.shelfKind !== "shelf" && marked.shelfKind !== "remote") {
          const applied = current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
          if (marked.completionKind) {
            const line = applied.lines[applied.cursorLine] ?? "";
            if (line[applied.cursorCol] !== " " && line[applied.cursorCol - 1] !== " ") {
              const next = [...applied.lines];
              next[applied.cursorLine] = line.slice(0, applied.cursorCol) + " " + line.slice(applied.cursorCol);
              return { ...applied, lines: next, cursorCol: applied.cursorCol + 1 };
            }
          }
          return applied;
        }
        const directory = marked.shelfKind === "remote" && item.label.endsWith("/");
        return applyRemoteCompletion(lines, cursorLine, cursorCol, item.value, prefix, directory);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const interception = shelfInterceptionContext(before, false);
        if (interception.kind === "shelf-command" || interception.kind === "add-dir-path" || interception.kind === "shelf-query") return true;
        if (interception.kind === "foreign-slash" || slashCommandToken(before)) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
        }
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

  // ;name expansion: murmo-style inline snippets. Only saved entries are expanded, and
  // only when the title is unique, so a typo can never inject the wrong text.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const text = event.text ?? "";
    // Cheap gate first: most messages contain no semicolon, and loading the shelf costs
    // two git calls.
    if (!text || text.trimStart().startsWith("/") || !/[;；]/.test(text)) return { action: "continue" };
    const layer = await loadLayer(ctx.cwd ?? process.cwd());
    const entries = itemsOf(layer)
      .filter((item) => !("dynamic" in item) || !item.dynamic)
      .map((item) => ({ title: item.title, value: item.value }));
    const next = expandShortcuts(text, entries);
    if (next == null) return { action: "continue" };
    return { action: "transform", text: next };
  });
  pi.registerCommand("shelf", {
    description: "分类架子：筛选后插入 / add / edit / rm / restore / harvest [topic] / topic / source / value / pin / prompt / fill / export / import / doctor / trust",
    handler: async (args, ctx) => {
      const shelf = ctx as ShelfCtx;
      const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const layer = await loadLayer(shelf.cwd ?? process.cwd());
      if (!verb) return pick(shelf);
      if (verb === "add") return addFlow(shelf, rest.join(" "));
      if (verb === "harvest") {
        // harvest() answers the agent tool with a string; the command handler returns void.
        await harvest(shelf, false, rest.join(" "));
        return;
      }
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
      if (verb === "value") return manageValues(shelf);
      if (verb === "alias") return manageAliases(shelf, pi);
      if (verb === "ref") return refFlow(shelf, layer, args.trim().replace(/^ref\b/i, "").trim());
      if (verb === "enrich") return enrichFlow(shelf);
      if (verb === "check") return checkFlow(shelf);
      if (verb === "stats") return statsFlow(shelf, layer);
      if (verb === "prompt") {
        const tail = args.trim().replace(/^prompt\b/, "").trim();
        if (!tail) return pick(shelf, "", true);
        if (tail === "add" || tail.startsWith("add ")) return addFlow(shelf, "Prompt");
        return usePrompt(shelf, tail);
      }
      if (verb === "fill") return fillEditor(shelf);
      if (verb === "dir" || verb === "file") return insertPath(shelf, verb);
      if (verb === "export") {
        // Exporting is the only cross-machine move that does not need a second service:
        // the JSON is the same shape as the store, so it can be edited before import.
        const scopes = rest[0] === "project" ? ["project"] : rest[0] === "global" ? ["global"] : ["global", "project"];
        const bag = {
          version: 1,
          exported: now(),
          items: scopes.flatMap((scope) => (scope === "project" ? layer.project?.items ?? [] : layer.collection.items).map((item) => ({ ...item, scope }))),
          archive: scopes.flatMap((scope) => (scope === "project" ? layer.project?.archive ?? [] : layer.collection.archive).map((item) => ({ ...item, scope }))),
          topics: scopes.flatMap((scope) => (scope === "project" ? layer.project?.topics ?? [] : layer.rules.topics).map((topic) => ({ ...topic, scope }))),
          sources: scopes.flatMap((scope) => (scope === "project" ? layer.project?.sources ?? [] : layer.rules.sources).map((source) => ({ ...source, scope }))),
          values: layer.rules.values,
          aliases: layer.rules.aliases,
        };
        const target = rest[1] || join(SHELF_DIR, `export-${new Date().toISOString().slice(0, 10)}.json`);
        await writeAtomic(target, bag);
        shelf.ui.notify(`已导出 ${bag.items.length} 条到 ${target}`, "info");
        return;
      }
      if (verb === "import") {
        const source = rest[0];
        if (!source) {
          shelf.ui.notify("用法：/shelf import <文件> [global|project]", "warning");
          return;
        }
        let bag: { items?: Item[]; topics?: TopicDef[]; sources?: DynamicSource[]; values?: ValueProvider[]; aliases?: Alias[] };
        try {
          bag = JSON.parse(await readFile(source, "utf8"));
        } catch (error) {
          shelf.ui.notify(`读不出 ${source}：${(error as Error).message}`, "error");
          return;
        }
        const items = Array.isArray(bag.items) ? bag.items : [];
        if (!items.length) {
          shelf.ui.notify("文件里没有条目。", "warning");
          return;
        }
        const target: Scope = rest[1] === "project" ? "project" : "global";
        if (target === "project" && (!layer.root || layer.remoteBlocked)) {
          shelf.ui.notify("当前目录没有可写的仓库架子。", "warning");
          return;
        }
        const ok = await shelf.ui.confirm(`并入 ${items.length} 条？`, `来自 ${source}\n同名 value 合并到已有条目，其余新增。`);
        if (!ok) return;
        let added = 0;
        for (const item of items) {
          if (!item.category || !item.title || !item.value) continue;
          await upsert(layer, { category: item.category, title: item.title, value: item.value, tags: item.tags, source: item.source }, target, shelf);
          added += 1;
        }
        if (Array.isArray(bag.topics) || Array.isArray(bag.sources) || Array.isArray(bag.values) || Array.isArray(bag.aliases)) {
          const bagRules: Rules = {
            version: 1,
            topics: Array.isArray(bag.topics) ? bag.topics : [],
            sources: Array.isArray(bag.sources) ? bag.sources : [],
            values: Array.isArray(bag.values) ? bag.values : [],
            aliases: Array.isArray(bag.aliases) ? bag.aliases : [],
          };
          if (target === "project") {
            const project = bagFor(layer, "project");
            project.topics = mergeRules({ version: 1, topics: project.topics, sources: [], values: [], aliases: [] }, bagRules).topics;
            project.sources = mergeRules({ version: 1, topics: [], sources: project.sources, values: [], aliases: [] }, bagRules).sources;
            project.values = mergeRules({ version: 1, topics: [], sources: [], values: project.values, aliases: [] }, bagRules).values;
            await saveProject(layer);
          } else {
            await saveRules(mergeRules(layer.rules, bagRules));
          }
        }
        shelf.ui.notify(`已并入 ${added} 条。`, "info");
        return;
      }
      if (verb === "doctor") return doctor(shelf, layer);
      if (verb === "trust") return trustFlow(shelf, layer);
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
        const matched = (await rows(shelf, layer, shelf.cwd ?? process.cwd()))
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
        const ok = await shelf.ui.confirm(`并入 @${params.category} ${params.title}`, `${params.value}${slotNote}\n#${(params.tags ?? []).join(" #")}`);
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
        if (!(await confirmDestructive(shelf, `归档 ${item.title}？`, "归档", "/shelf restore 可以恢复"))) {
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
