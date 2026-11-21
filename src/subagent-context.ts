import { randomUUID } from "node:crypto";
import type { AgentModelContext } from "./models.ts";

export type CompletionEventBus = {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
};
const REQUEST = "subagent:slash:request";
const STARTED = "subagent:slash:started";
const RESPONSE = "subagent:slash:response";
const CANCEL = "subagent:slash:cancel";
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function parseAgentCapabilities(data: unknown): AgentModelContext[] | undefined {
  const response = record(data);
  if (response?.isError === true) return undefined;
  const result = record(response?.result);
  if (result?.isError === true) return undefined;
  const rows = record(record(result?.details)?.agentCapabilities)?.agents;
  if (!Array.isArray(rows)) return undefined;
  return rows.slice(0, 2000).flatMap((raw): AgentModelContext[] => {
    const row = record(raw);
    const runner = record(row?.runner)?.type;
    if (!row || typeof row.name !== "string" || !row.name || row.name.length > 256 || !["pi", "external-cli", "external-job"].includes(String(runner)) || typeof row.executable !== "boolean") return [];
    const model = record(row.model);
    return [{
      name: row.name, runner: runner as AgentModelContext["runner"], executable: row.executable,
      ...(Array.isArray(row.aliases) ? { aliases: row.aliases.filter((alias): alias is string => typeof alias === "string" && alias.length <= 256) } : {}),
      ...(typeof model?.value === "string" ? { model: model.value } : {}),
      ...(typeof model?.thinking === "string" || model?.thinking === false ? { thinking: model.thinking } : {}),
      // The installed public projection does not include modelScope/maxThinking.
      policyChecked: false,
    }];
  });
}

/** Reuse the installed read-only list action. No child, model call or UI message. */
export function createSubagentContextClient(events: CompletionEventBus | undefined, getContext: () => unknown, ttlMs = 3000, timeoutMs = 1000) {
  let cached: { key: string; at: number; rows?: AgentModelContext[] } | undefined;
  let pending: { key: string; promise: Promise<AgentModelContext[] | undefined> } | undefined;
  let generation = 0;
  const disposers = new Set<() => void>();
  const load = (key: string): Promise<AgentModelContext[] | undefined> => {
    if (!events) return Promise.resolve(undefined);
    if (cached?.key === key && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.rows);
    if (pending?.key === key) return pending.promise;
    const requestGeneration = generation;
    const promise = new Promise<AgentModelContext[] | undefined>((resolve) => {
      const requestId = `pi-shelf-models-${randomUUID()}`;
      let done = false;
      let started = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off: Array<() => void> = [];
      const finish = (rows: AgentModelContext[] | undefined, cancel = false) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        for (const unsubscribe of off) unsubscribe();
        disposers.delete(dispose);
        if (cancel && started) events.emit(CANCEL, { requestId });
        if (requestGeneration === generation) cached = { key, at: Date.now(), rows };
        resolve(rows);
      };
      const dispose = () => finish(undefined, true);
      disposers.add(dispose);
      try {
        off.push(events.on(STARTED, (data) => { if (record(data)?.requestId === requestId) started = true; }));
        off.push(events.on(RESPONSE, (data) => { if (record(data)?.requestId === requestId) finish(parseAgentCapabilities(data)); }));
        timer = setTimeout(dispose, timeoutMs);
        events.emit(REQUEST, { requestId, ctx: getContext(), params: { action: "list", agentScope: "both", options: { capabilities: true } } });
        // The installed bridge acknowledges before its first await. An absent
        // listener must not impose a timeout on every Tab or leak cancel IDs.
        if (!started && !done) finish(undefined);
      } catch {
        finish(undefined, true);
      }
    });
    pending = { key, promise };
    void promise.finally(() => { if (pending?.promise === promise) pending = undefined; });
    return promise;
  };
  return {
    async get(agent: string, key: string, signal: AbortSignal) {
      if (signal.aborted) return undefined;
      const rows = await new Promise<AgentModelContext[] | undefined>((resolve) => {
        const aborted = () => { signal.removeEventListener("abort", aborted); resolve(undefined); };
        signal.addEventListener("abort", aborted, { once: true });
        void load(key).then((result) => { signal.removeEventListener("abort", aborted); resolve(signal.aborted ? undefined : result); });
      });
      if (signal.aborted) return undefined;
      const matches = rows?.filter((row) => row.name === agent || row.aliases?.includes(agent));
      return matches?.length === 1 ? matches[0] : undefined;
    },
    dispose() {
      generation += 1;
      for (const dispose of [...disposers]) dispose();
      pending = undefined;
      cached = undefined;
    },
  };
}
