import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { commandAt, modelInputContext, type ModelInputContext } from "./model-context.ts";
import {
  allowedModel, modelCatalog, modelKey, modelWithThinking, rankedModels,
  supportedThinkingLevels, thinkingLevel, type AgentModelContext, type ModelLike, type ThinkingLevel,
} from "./models.ts";

export type ModelCompletionOptions = {
  current: AutocompleteProvider;
  getModels: () => readonly ModelLike[];
  getRunCommands: () => readonly string[];
  getAgent?: (name: string, signal: AbortSignal) => Promise<AgentModelContext | undefined>;
  getPreferredProvider?: () => string | undefined;
  scores?: (group: "model" | "provider") => ReadonlyMap<string, number>;
  accepted?: (group: "model" | "provider", value: string) => void;
  notify?: (message: string) => void;
};
type ModelItem = AutocompleteItem & {
  kind: "model" | "provider" | "browse" | "thinking" | "agent" | "key";
  context: ModelInputContext;
  model?: ModelLike;
  level?: ThinkingLevel;
  agent?: AgentModelContext;
  complete: boolean;
  group?: "model" | "provider";
};
const MAX_MODELS = 10;
const MAX_PROVIDERS = 8;
const MAX_RECENT = 4;
const safeInline = (value: string) => !/[\s,\[\]"'`]/u.test(value);
const policyNote = (ctx: ModelInputContext, agent?: AgentModelContext) => ctx.run && !agent?.policyChecked ? " · 角色限制启动时校验" : "";
const noChange = (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol });

function candidateItems(ctx: ModelInputContext, all: ModelLike[], options: ModelCompletionOptions, agent?: AgentModelContext): ModelItem[] {
  const models = all.filter((model) => allowedModel(model, agent) && (!ctx.run || safeInline(modelKey(model))));
  const context = ctx;
  const note = policyNote(ctx, agent);
  const base = (item: Omit<ModelItem, "context" | "agent">): ModelItem => ({ ...item, context, agent });
  const thinking = modelWithThinking(ctx.query, models);
  if (ctx.kind !== "provider" && thinking) {
    return supportedThinkingLevels(thinking.model, agent?.maxThinking).filter((level) => level.startsWith(thinking.query)).map((level) => {
      const value = `${modelKey(thinking.model)}:${level}`;
      const mapping = thinking.model.thinkingLevelMap?.[level];
      return base({ value, label: value, description: `思考 ${level}${mapping && mapping !== level ? ` → ${mapping}` : ""}${note}`, kind: "thinking", model: thinking.model, level, complete: true, group: "model" });
    });
  }
  const providers = [...new Set(models.map((model) => model.provider))];
  const providerQuery = ctx.query.toLowerCase();
  const providerMatches = providers.filter((name) => name.toLowerCase().includes(providerQuery))
    .sort((a, b) => Number(b.toLowerCase().startsWith(providerQuery)) - Number(a.toLowerCase().startsWith(providerQuery)) ||
      (options.scores?.("provider").get(b) ?? 0) - (options.scores?.("provider").get(a) ?? 0) || a.localeCompare(b)).slice(0, MAX_PROVIDERS);
  if (ctx.kind === "provider") return providerMatches.map((value) => base({ value, label: value, description: "provider 名", kind: "provider", complete: true, group: "provider" }));

  const items: ModelItem[] = [];
  // Remember complete model+thinking choices. Revalidate every time; stale or
  // out-of-policy combinations never become an insertion shortcut.
  const scores = options.scores?.("model") ?? new Map<string, number>();
  if (ctx.explicit && ctx.kind !== "id") {
    const recent = [...scores].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);
    for (const [value] of recent) {
      const match = modelWithThinking(value, models);
      if (!match || !thinkingLevel(match.query) || !value.toLowerCase().includes(ctx.query.toLowerCase())) continue;
      const level = thinkingLevel(match.query)!;
      if (!supportedThinkingLevels(match.model, agent?.maxThinking).includes(level)) continue;
      items.push(base({ value, label: value, description: `最近使用 · 思考 ${level}${note}`, kind: "thinking", model: match.model, level, complete: true, group: "model" }));
      if (items.length >= MAX_RECENT) break;
    }
  }
  if (ctx.kind !== "id" && !ctx.query.includes("/")) {
    for (const provider of providerMatches) {
      if (!ctx.run && !ctx.tag) items.push(base({ value: provider, label: `[provider] ${provider}`, description: "插入 provider 名", kind: "provider", complete: true, group: "provider" }));
      items.push(base({ value: `${provider}/`, label: `${provider}/`, description: "选择此 provider 的模型 · 再按 Tab", kind: "browse", complete: false }));
    }
  }
  let ranked = rankedModels(models, ctx.query, options.getPreferredProvider?.());
  // Generic words need a strong model-name match. Explicit syntax remains fuzzy.
  if (!ctx.explicit) ranked = ranked.filter((model) => {
    const q = ctx.query.toLowerCase();
    return modelKey(model).toLowerCase().startsWith(q) || model.id.toLowerCase().startsWith(q) || (model.name ?? "").toLowerCase().startsWith(q);
  });
  for (const model of ranked.slice(0, MAX_MODELS)) {
    const key = modelKey(model);
    const value = ctx.kind === "id" ? model.id : key;
    if (ctx.kind !== "id") items.push(base({ value: `${key}:`, label: `${key}:…`, description: `选择思考强度 · 再按 Tab${note}`, kind: "model", model, complete: false }));
    items.push(base({ value, label: ctx.kind === "id" ? `${model.id} · ${model.provider}` : key, description: `${model.name ?? model.id} · ${ctx.run ? "沿用角色有效默认" : "不指定思考强度"}${note}`, kind: "model", model, complete: true, group: "model" }));
  }
  return items;
}

/** Outer layer: retains each inner item's exact apply function and replacement prefix. */
export function createModelCompletionProvider(options: ModelCompletionOptions): AutocompleteProvider {
  const { current } = options;
  const own = new WeakMap<AutocompleteItem, { item: ModelItem; line: string; row: number; col: number }>();
  const native = new WeakMap<AutocompleteItem, { item: AutocompleteItem; prefix: string }>();
  const remember = (items: ModelItem[], line: string, row: number, col: number) => items.map((item) => { own.set(item, { item, line, row, col }); return item; });
  const getModels = () => { try { return modelCatalog(options.getModels()); } catch { return []; } };
  const runCommands = () => { try { return options.getRunCommands(); } catch { return []; } };
  const delegate = async (lines: string[], row: number, col: number, opts: { signal: AbortSignal; force?: boolean }) => {
    const command = commandAt((lines[row] ?? "").slice(0, col));
    // A forced Tab bypasses native slash argument callbacks. Query those first,
    // then fall back to the original forced file completion if no semantic hits.
    if (command && !command.bare && opts.force && !/^(?:add-dir|shelf)(?::[0-9]+)?$/.test(command.name)) {
      const semantic = await current.getSuggestions(lines, row, col, { ...opts, force: false });
      if (semantic?.items.length || opts.signal.aborted) return semantic;
    }
    return current.getSuggestions(lines, row, col, opts);
  };
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ":", "^"])],
    async getSuggestions(lines, row, col, opts) {
      if (opts.signal.aborted) return null;
      const line = lines[row] ?? "";
      const ctx = modelInputContext(line, col, opts.force === true, runCommands());
      if (!ctx) return delegate(lines, row, col, opts);
      if (ctx.kind === "run-agent") {
        const original = await current.getSuggestions(lines, row, col, { ...opts, force: false });
        if (opts.signal.aborted) return null;
        const agentRows = (original?.items ?? []).filter((item) => safeInline(item.value) && !item.value.includes("["));
        const roleRows = await Promise.all(agentRows.slice(0, 40).map(async (item) => {
          try { return options.getAgent ? await options.getAgent(item.value, opts.signal) : undefined; } catch { return undefined; }
        }));
        if (opts.signal.aborted) return null;
        const extra = agentRows.slice(0, 40).flatMap((item, index) => {
          const role = roleRows[index];
          if (role && (role.runner !== "pi" || !role.executable)) return [];
          return [{ value: `${item.value}[model=`, label: `${item.label} · 配置本次模型`, description: "provider → model → thinking", kind: "agent" as const, context: ctx, complete: false }];
        });
        if (!extra.length) return original;
        return { prefix: line.slice(ctx.start, col), items: [...(original?.items ?? []), ...remember(extra, line, row, col)] };
      }
      if (ctx.kind === "run-key") {
        return { prefix: line.slice(ctx.start, col), items: remember([{ value: "model=", label: "model=", description: "选择本次模型与思考强度", kind: "key", context: ctx, complete: false }], line, row, col) };
      }
      let agent: AgentModelContext | undefined;
      if (ctx.agent && options.getAgent) {
        try { agent = await options.getAgent(ctx.agent, opts.signal); } catch { /* metadata is optional */ }
        if (opts.signal.aborted) return null;
      }
      // External runners use a different model namespace; never feed them Pi ids.
      if (agent && (agent.runner !== "pi" || !agent.executable)) return null;
      const models = getModels();
      const items = remember(candidateItems(ctx, models, options, agent), line, row, col);
      if (ctx.run || ctx.tag || line.slice(ctx.start, col).startsWith(":")) return items.length ? { prefix: line.slice(ctx.start, col), items } : null;
      if (!items.length) return ctx.explicit ? null : delegate(lines, row, col, opts);
      let original: AutocompleteSuggestions | null = null;
      try { original = await delegate(lines, row, col, opts); } catch { /* retain model choices on native failure */ }
      if (opts.signal.aborted) return null;
      const innerItems = (original?.items ?? []).map((item) => {
        const clone = { ...item };
        native.set(clone, { item, prefix: original!.prefix });
        return clone;
      });
      return { prefix: line.slice(ctx.start, col), items: [...innerItems, ...items] };
    },
    applyCompletion(lines, row, col, selected, prefix) {
      const origin = native.get(selected);
      if (origin) return current.applyCompletion(lines, row, col, origin.item, origin.prefix);
      const receipt = own.get(selected);
      if (!receipt) return current.applyCompletion(lines, row, col, selected, prefix);
      const { item } = receipt;
      const line = lines[row] ?? "";
      const ctx = item.context;
      // Do not apply a stale candidate after an editor change or registry update.
      if (line !== receipt.line || row !== receipt.row || col !== receipt.col || line.slice(ctx.start, col) !== prefix) return noChange(lines, row, col);
      if (item.model) {
        const fresh = getModels().find((model) => modelKey(model) === modelKey(item.model!));
        if (!fresh || !allowedModel(fresh, item.agent) || (item.level && !supportedThinkingLevels(fresh, item.agent?.maxThinking).includes(item.level))) {
          options.notify?.("模型或思考强度已变化，请重新补全。");
          return noChange(lines, row, col);
        }
      }
      let value = (ctx.tag ?? "") + selected.value;
      let after = line.slice(ctx.end);
      if (ctx.run && item.complete) {
        if (after.startsWith("]")) {
          after = after.slice(1);
          value += "]";
        } else if (!after.startsWith(",")) {
          value += "]";
        }
        if (!after.startsWith(",") && after.length === 0) value += " ";
      } else if (!ctx.run && item.complete) {
        if (ctx.quote) {
          if (after.startsWith(ctx.quote)) after = after.slice(1);
          value += ctx.quote;
        }
        if (!after || !/^[\s,，。；;\])}>'"`]/u.test(after)) value += " ";
      }
      const head = line.slice(0, ctx.start) + value;
      const next = [...lines];
      next[row] = head + after;
      if (item.complete && item.group) options.accepted?.(item.group, selected.value);
      return { lines: next, cursorLine: row, cursorCol: head.length };
    },
    shouldTriggerFileCompletion(lines, row, col) {
      if (modelInputContext(lines[row] ?? "", col, true, runCommands())) return true;
      return current.shouldTriggerFileCompletion?.(lines, row, col) ?? true;
    },
  };
}
