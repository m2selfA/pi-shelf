// Model identity and thinking rules shared by prose and /run completion.
// Matches the Pi 1.2/1.6 host capability rules and the pi-subagents 0.89 suffix
// vocabulary. Never infer a provider or a higher thinking level from a name.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ModelLike = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};
export type AgentModelContext = {
  name: string;
  aliases?: string[];
  runner: "pi" | "external-cli" | "external-job";
  executable: boolean;
  model?: string;
  thinking?: string | false;
  /** Optional authoritative policy projection; absent is unknown, never unrestricted. */
  maxThinking?: ThinkingLevel;
  allowedModels?: readonly string[];
  policyChecked?: boolean;
};
export type ModelSpec = { provider: string; modelId: string; thinking?: ThinkingLevel };

export function modelKey(model: Pick<ModelLike, "provider" | "id">) {
  return `${model.provider}/${model.id}`;
}

export function modelCatalog(models: readonly ModelLike[]): ModelLike[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id) return false;
    // Control characters cannot form a single editor token. Printable Unicode is valid.
    if (/[\u0000-\u001f\u007f]/u.test(model.provider + model.id)) return false;
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function thinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return THINKING_LEVELS.find((level) => level === value);
}

export function supportedThinkingLevels(model: ModelLike, ceiling?: ThinkingLevel): ThinkingLevel[] {
  // The host treats absent reasoning metadata as non-reasoning, even though the
  // subagent admin picker is more permissive. This intersection avoids host clamping.
  const levels = !model.reasoning ? ["off" as const] : THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  return levels.filter((level) => !ceiling || THINKING_LEVELS.indexOf(level) <= THINKING_LEVELS.indexOf(ceiling));
}

export function allowedModel(model: ModelLike, agent?: AgentModelContext) {
  return agent?.executable !== false && (!agent?.allowedModels || agent.allowedModels.includes(modelKey(model)));
}

export function serializeModelSpec(spec: ModelSpec) {
  return `${spec.provider}/${spec.modelId}${spec.thinking ? `:${spec.thinking}` : ""}`;
}

/** A colon inside the registry id is data; only a suffix after a known full id is thinking. */
export function modelWithThinking(text: string, models: readonly ModelLike[]) {
  if (models.some((model) => modelKey(model) === text)) return undefined;
  const model = [...models].sort((a, b) => modelKey(b).length - modelKey(a).length)
    .find((entry) => text.startsWith(modelKey(entry) + ":"));
  return model ? { model, query: text.slice(modelKey(model).length + 1) } : undefined;
}

export function modelRank(model: ModelLike, query: string) {
  const key = modelKey(model).toLowerCase();
  const id = model.id.toLowerCase();
  const name = (model.name ?? "").toLowerCase();
  const q = query.toLowerCase();
  if (!q || key === q || id === q) return 0;
  if (key.startsWith(q) || id.startsWith(q)) return 1;
  if (id.split(/[\s/_.:-]+/u).some((part) => part.startsWith(q)) || name.startsWith(q)) return 2;
  if (key.includes(q) || name.includes(q)) return 3;
  // Scattered matches are useful for deliberate fuzzy queries, but too noisy for
  // tiny fragments such as "ws" in a saved alias or normal prose.
  if (q.length < 3) return Infinity;
  let i = 0;
  for (const char of key) if (char === q[i]) i += 1;
  return i === q.length ? 4 : Infinity;
}

export function rankedModels(models: readonly ModelLike[], query: string, preferredProvider?: string) {
  const provider = [...new Set(models.map((model) => model.provider))]
    .sort((a, b) => b.length - a.length).find((name) => query.startsWith(name + "/"));
  return models.filter((model) => !provider || model.provider === provider)
    .map((model) => ({ model, rank: modelRank(model, query) }))
    .filter((hit) => hit.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || Number(b.model.provider === preferredProvider) - Number(a.model.provider === preferredProvider) || modelKey(a.model).localeCompare(modelKey(b.model)))
    .map((hit) => hit.model);
}
