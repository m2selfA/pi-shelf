import type { Row } from "./match.ts";

export type Part = { text: string; placement?: Row["placement"]; order?: number };

function rank(part: Part) {
  if (part.placement === "prepend") return 0;
  if (part.placement === "append") return 2;
  return 1;
}

/**
 * Compose several entries into one insertion. Prepend parts come first, then ordinary
 * parts, then append parts; ties keep the author's order, so the result is stable no
 * matter which order the user selected them in.
 */
export function composeParts(parts: Part[], separator = "\n\n"): string {
  return parts
    .map((part, index) => ({ part, index }))
    .sort((a, b) => rank(a.part) - rank(b.part) || (a.part.order ?? 0) - (b.part.order ?? 0) || a.index - b.index)
    .map(({ part }) => part.text.trim())
    .filter(Boolean)
    .join(separator);
}
