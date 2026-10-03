export type Slot = { name: string; fallback: string; choices: string[] };

const SLOT = /\{\{([^{}]+)\}\}/g;

function parseSlot(body: string): Slot {
  const colon = body.indexOf(":");
  const head = (colon >= 0 ? body.slice(0, colon) : body).trim();
  const choiceText = colon >= 0 ? body.slice(colon + 1) : "";
  const eq = head.indexOf("=");
  const name = (eq >= 0 ? head.slice(0, eq) : head).trim();
  const fallback = eq >= 0 ? head.slice(eq + 1).trim() : "";
  const choices = choiceText.split("|").map((item) => item.trim()).filter(Boolean);
  return { name, fallback, choices };
}

export function templateSlots(value: string): Slot[] {
  const slots: Slot[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(SLOT)) {
    const slot = parseSlot(match[1] ?? "");
    if (!slot.name || seen.has(slot.name)) continue;
    seen.add(slot.name);
    slots.push(slot);
  }
  return slots;
}

export function fillTemplate(value: string, values: Record<string, string>) {
  return value.replace(SLOT, (full, body: string) => {
    const slot = parseSlot(body);
    const given = values[slot.name];
    return given == null ? slot.fallback || full : given;
  });
}

export function sessionFolder(cwd: string) {
  return `--${cwd.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`;
}

export function sessionExcerpt(jsonl: string, limit = 800) {
  const texts: string[] = [];
  for (const line of jsonl.split(/\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
    const message = record.message ?? record;
    if (message.role && message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") texts.push(block.text);
      }
    }
  }
  const useful = texts.map((text) => text.trim()).filter((text) => text && !text.startsWith("/"));
  return {
    title: (useful[0] ?? "").replace(/\s+/g, " ").slice(0, 80),
    excerpt: useful.join("\n").slice(0, limit),
  };
}

export function splitArgs(text: string) {
  const args: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (current) args.push(current);
      current = "";
    } else current += ch;
  }
  if (current) args.push(current);
  return args;
}

export function parsePromptMarkdown(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let description = "";
  let argumentHint = "";
  let body = text;
  if (match) {
    body = text.slice(match[0].length);
    for (const line of (match[1] ?? "").split(/\n/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "description") description = val;
      if (key === "argument-hint" || key === "argument_hint") argumentHint = val;
    }
  }
  return { description, argumentHint, body: body.replace(/^\n/, "") };
}

export function applyPositionals(value: string, args: string[]) {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value.startsWith("${", i)) {
      const end = value.indexOf("}", i + 2);
      if (end < 0) {
        out += value[i];
        i += 1;
        continue;
      }
      const body = value.slice(i + 2, end);
      const numbered = body.match(/^(\d+):-([\s\S]*)$/);
      if (numbered) {
        out += args[Number(numbered[1]) - 1] ?? numbered[2] ?? "";
      } else if (body.startsWith("@:-")) {
        out += args.length ? args.join(" ") : body.slice(3);
      } else if (body.startsWith("@:")) {
        const spec = body.slice(2);
        const colon = spec.indexOf(":");
        const start = Number(colon >= 0 ? spec.slice(0, colon) : spec);
        const count = colon >= 0 ? Number(spec.slice(colon + 1)) : undefined;
        const part = Number.isFinite(start) && start > 0 ? args.slice(start - 1, count == null ? undefined : start - 1 + count) : [];
        out += part.join(" ");
      } else out += value.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (value.startsWith("$ARGUMENTS", i)) {
      out += args.join(" ");
      i += "$ARGUMENTS".length;
      continue;
    }
    if (value.startsWith("$@", i)) {
      out += args.join(" ");
      i += 2;
      continue;
    }
    const num = value.slice(i).match(/^\$(\d+)/);
    if (num) {
      const got = args[Number(num[1]) - 1];
      out += got == null ? `{{$${num[1]}}}` : got;
      i += num[0].length;
      continue;
    }
    out += value[i];
    i += 1;
  }
  return out;
}
