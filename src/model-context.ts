export type ModelInputContext = {
  kind: "model" | "provider" | "id" | "run-agent" | "run-key";
  start: number;
  end: number;
  query: string;
  /** Explicit syntaxes own the token even when no matching model exists. */
  explicit: boolean;
  agent?: string;
  run?: boolean;
  quote?: string;
  /** A visible model mention, preserved across provider/model/thinking stages. */
  tag?: "^";
};

export function commandAt(text: string) {
  const match = text.match(/^\s*\/([^\s/\\]+)(?:[ \t]+|$)/u);
  return match ? { name: match[1]!, argsStart: match[0].length, bare: !/[ \t]$/u.test(match[0]) } : undefined;
}

function valueEnd(line: string, start: number, run: boolean) {
  const rest = line.slice(start);
  const stop = rest.search(run ? /[\s,\]]/u : /[\s,，。；;\])}>'"`]/u);
  return stop < 0 ? line.length : start + stop;
}

/** Exact model-value spans, including any suffix to the right of the cursor. */
export function modelInputContext(line: string, col: number, forced: boolean, runCommands: readonly string[] = []): ModelInputContext | undefined {
  const before = line.slice(0, col);
  const command = commandAt(before);
  if (command && runCommands.includes(command.name) && !command.bare) {
    const args = before.slice(command.argsStart);
    // The installed /run parser splits at its first literal space. Do not pretend
    // that quoted or spaced agent inline configs are accepted by that grammar.
    if (!/[\s]/u.test(args)) {
      const bracket = args.indexOf("[");
      if (bracket < 0) return { kind: "run-agent", start: command.argsStart, end: valueEnd(line, command.argsStart, true), query: args, explicit: true, run: true };
      if (!args.includes("]")) {
        const agent = args.slice(0, bracket);
        const fieldStart = Math.max(bracket, args.lastIndexOf(",")) + 1;
        const field = args.slice(fieldStart);
        const start = command.argsStart + fieldStart;
        if (field.startsWith("model=")) {
          const valueStart = start + 6;
          return { kind: "model", start: valueStart, end: valueEnd(line, valueStart, true), query: line.slice(valueStart, col), explicit: true, agent, run: true };
        }
        if ("model".startsWith(field) && !/(?:^|,)model=/u.test(args.slice(bracket + 1, fieldStart))) {
          return { kind: "run-key", start, end: valueEnd(line, start, true), query: field, explicit: true, agent, run: true };
        }
      }
    }
    // Text after the agent token is the task, not another inline config.
  }

  const tag = before.match(/(?:^|[\s([{，。；：、\x60"'])\^([^\s,，。；;\])}>'"`]*?)$/u);
  if (tag) {
    const query = tag[1] ?? "";
    const start = col - query.length - 1;
    return { kind: "model", start, end: valueEnd(line, start, false), query, explicit: true, tag: "^" };
  }
  const explicit = before.match(/(?:^|[\s([{\x60"'])(:(model|provider|id):)([^\s,，。；;\])}>'"`]*?)$/u);
  if (explicit) {
    const query = explicit[3] ?? "";
    const start = col - query.length - explicit[1]!.length;
    return { kind: explicit[2] as "model" | "provider" | "id", start, end: valueEnd(line, start, false), query, explicit: true };
  }
  // These commands have established non-model argument semantics. Their native
  // completion must win; an explicit :model: marker remains available above.
  if (command && /^(?:model|login|shelf|add-dir|remove-dir)(?::\d+)?$/u.test(command.name)) return undefined;
  const flag = before.match(/--(model|provider)(?:=|[ \t]+)(["']?)([^\s"']*)$/u);
  if (flag) {
    const query = flag[3] ?? "";
    const start = col - query.length;
    return { kind: flag[1] as "model" | "provider", start, end: valueEnd(line, start, false), query, explicit: true, ...(flag[2] ? { quote: flag[2] } : {}) };
  }
  if (!forced || command?.bare) return undefined;
  const query = before.match(/[^\s,，。；;\])}>'"`]+$/u)?.[0] ?? "";
  if (query.length < 2 || /^(?:[.@#~\\/]|[A-Za-z]:|\w+:\/\/)/u.test(query)) return undefined;
  if (query.includes("\\") || (query.includes(":") && !query.includes("/"))) return undefined;
  return { kind: "model", start: col - query.length, end: valueEnd(line, col - query.length, false), query, explicit: false };
}
