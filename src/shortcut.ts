export type ShortcutEntry = { title: string; value: string };

// CJK range written as literal characters (U+4E00–U+9FA5) so no escape can go wrong.
const NAME = "[A-Za-z0-9_一-龥.-]{1,64}";
// ASCII ; needs a boundary before it, so "x;review" in code or a URL is not a trigger.
const ASCII = new RegExp("(^|[\\s，。、,.;!?！？]);(" + NAME + ")(?=$|[\\s，。、,.;!?！？])", "g");
// The full-width ； is punctuation on its own, so it triggers after CJK text too.
const WIDE = new RegExp("；(" + NAME + ")(?=$|[\\s，。、,.;!?！？])", "g");

/**
 * Expand ;name tokens in a message, murmo-style. A token only expands when exactly one
 * saved entry has that title, so a duplicate never expands into the wrong text. Returns
 * null when nothing changed, which is the caller's signal to leave the message alone.
 */
export function expandShortcuts(text: string, entries: ShortcutEntry[]): string | null {
  const byTitle = new Map<string, ShortcutEntry[]>();
  for (const entry of entries) {
    if (!entry.title.trim()) continue;
    const key = entry.title.trim().toLowerCase();
    const list = byTitle.get(key) ?? [];
    list.push(entry);
    byTitle.set(key, list);
  }
  let changed = false;
  const replace = (full: string, lead: string, name: string) => {
    const matches = byTitle.get(name.toLowerCase());
    if (!matches || matches.length !== 1) return full;
    changed = true;
    return lead + matches[0]!.value;
  };
  const wide = text.replace(WIDE, (full, name: string) => replace(full, "", name));
  const next = wide.replace(ASCII, (full, lead: string, name: string) => replace(full, lead, name));
  return changed ? next : null;
}
