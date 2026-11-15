import { Input, SelectList, getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { label, rankRows, type Row } from "./match.ts";
import { templateSlots } from "./template.ts";

export type PickerOptions = {
  rows: Row[];
  /** Seed for the filter box: the word before the cursor when the picker opened. */
  initial?: string;
  limit?: number;
  title?: string;
  /** Allow Tab to mark several rows for one combined insertion. */
  multi?: boolean;
};

const MAX_VISIBLE = 10;
const PREVIEW_WIDTH = 44;
const MIN_SPLIT_WIDTH = 76;

function scopeText(row: Row) {
  if (row.dynamic) return "动态";
  return row.scope === "project" ? "仓库" : "全局";
}

/** Everything the list cannot show: full value, tags, provenance, usage. */
export function previewText(row: Row | undefined, width: number, theme: Theme): string[] {
  if (!row) return [theme.fg("muted", "没有匹配。放宽标签，或 /shelf add 新增。")];
  const tags = row.tags?.length ? " #" + row.tags.join(" #") : "";
  const slots = templateSlots(row.value).map((slot) => slot.name);
  const lines = [
    theme.fg("accent", theme.bold(row.title || "(无标题)")),
    theme.fg("muted", `@${row.category} · ${scopeText(row)}${tags}`),
    theme.fg("dim", `uses ${row.uses}${row.lastUsed ? ` · 上次 ${row.lastUsed.slice(0, 10)}` : ""}${row.updated ? ` · 改于 ${row.updated.slice(0, 10)}` : ""}`),
  ];
  if (slots.length) lines.push(theme.fg("dim", `变量 ${slots.join(", ")}`));
  lines.push("");
  for (const line of (row.value || "").split("\n")) {
    if (!line) {
      lines.push("");
      continue;
    }
    lines.push(...wrapTextWithAnsi(line, Math.max(8, width)));
  }
  return lines;
}

type PickerState = {
  rows: Row[];
  filtered: Row[];
  selected: number;
  list: SelectList;
  query: string;
};

/**
 * One-screen picker: a live filter box on top, scored results on the left, the full entry
 * on the right. Rebuilding the SelectList on every keystroke keeps Pi's own scrolling,
 * mouse and keybinding handling while this module owns the ranking.
 */
export function createPicker(
  tui: TUI,
  theme: Theme,
  options: PickerOptions,
  done: (rows: Row[]) => void,
): Component & Focusable & { handleInput: (data: string) => void; dispose?: () => void } {
  const limit = options.limit ?? 200;
  const multi = options.multi !== false;
  const input = new Input({ prompt: "筛选 ", placeholder: "@类 #标签 关键字" });
  input.setValue(options.initial ?? "");
  let closed = false;
  const chosen = new Set<string>();
  let state: PickerState = { rows: options.rows, filtered: [], selected: 0, list: null as unknown as SelectList, query: "" };

  const finish = (rows: Row[]) => {
    if (closed) return;
    closed = true;
    done(rows);
  };

  const rebuild = (reset = true) => {
    const query = input.getValue();
    // A changed query resets the highlight to the best hit; marking a row must not, or
    // Tab would jump back to the top and the next Tab would toggle the wrong row.
    const keepId = reset ? undefined : state.filtered[state.selected]?.id;
    const hits = rankRows(state.rows, query, limit);
    const filtered = hits.map((hit) => hit.row);
    const keep = keepId ? filtered.findIndex((row) => row.id === keepId) : -1;
    state = { ...state, query, filtered, selected: keep >= 0 ? keep : 0 };
    const items: SelectItem[] = state.filtered.map((row, index) => ({
      value: String(index),
      // The check mark is part of the label so SelectList keeps its own truncation and
      // scrolling; chosen rows stay visible after a new filter.
      label: `${chosen.has(row.id) ? "✓" : " "} ${label(row)}`,
    }));
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE), getSelectListTheme(), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 48,
    });
    list.setSelectedIndex(state.selected);
    list.onSelect = (item) => finish(collect(item));
    list.onCancel = () => finish([]);
    list.onSelectionChange = (item) => {
      state.selected = Number(item.value);
      tui.requestRender();
    };
    state.list = list;
    return list;
  };

  // Enter returns the marked rows when there are any, otherwise the highlighted one.
  const collect = (item?: SelectItem): Row[] => {
    if (chosen.size) return state.rows.filter((row) => chosen.has(row.id));
    const index = item ? Number(item.value) : state.selected;
    const row = item ? state.filtered[index] : state.filtered[state.selected];
    return row ? [row] : [];
  };

  rebuild();

  const move = (data: string) => {
    // SelectList owns the index; mirror it so the preview follows the highlighted row, and
    // always repaint: the preview has to change even when the index lands on the same row.
    state.list.handleInput(data);
    const picked = state.list.getSelectedItem();
    if (picked) state.selected = Number(picked.value);
    tui.requestRender();
  };

  const page = (direction: number) => {
    if (!state.filtered.length) return;
    // A page is one visible window minus the row kept for context.
    const step = Math.max(1, MAX_VISIBLE - 1);
    const next = Math.max(0, Math.min(state.filtered.length - 1, state.selected + direction * step));
    state.selected = next;
    state.list.setSelectedIndex(next);
    tui.requestRender();
  };

  return {
    // Focusing the filter box hands the terminal cursor to it; without this the input
    // renders a fake block cursor instead of the real one.
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    invalidate() {
      input.invalidate();
      state.list.invalidate();
    },
    dispose() {
      closed = true;
    },
    handleInput(data: string) {
      if (closed) return;
      const keybindings = getKeybindings();
      if (keybindings.matches(data, "tui.select.cancel")) return finish([]);
      // Tab marks the highlighted row; Enter then inserts everything marked.
      if (multi && data === "\t") {
        const row = state.filtered[state.selected];
        if (row) {
          if (chosen.has(row.id)) chosen.delete(row.id);
          else chosen.add(row.id);
          rebuild(false);
          tui.requestRender();
        }
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        return finish(collect());
      }
      if (keybindings.matches(data, "tui.select.pageUp")) return page(-1);
      if (keybindings.matches(data, "tui.select.pageDown")) return page(1);
      if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
        return move(data);
      }
      input.handleInput(data);
      rebuild();
      tui.requestRender();
    },
    render(width: number) {
      const selected = state.filtered[state.selected];
      const lines: string[] = [];
      const count = state.filtered.length === state.rows.length ? `${state.rows.length}` : `${state.filtered.length}/${state.rows.length}`;
      // Style after clipping: clipping a styled string can cut an escape sequence in half.
      const title = `${options.title ?? "架子"}  ${count}`;
      const hint = width >= 60 ? `   ↑↓ 选择 · ${multi ? "Tab 多选 · " : ""}Enter 插入 · Esc 取消` : "";
      const header = truncateToWidth(title + hint, width, "");
      lines.push(theme.fg("accent", theme.bold(header)));
      lines.push(...input.render(width));
      lines.push("");

      if (!state.filtered.length) {
        lines.push(theme.fg("muted", "没有匹配。放宽标签，或 /shelf add 新增。"));
        return lines;
      }
      // Narrow terminals keep the list only: a 30-column preview is worse than none.
      if (width < MIN_SPLIT_WIDTH) {
        lines.push(...state.list.render(width));
        return lines;
      }
      const previewWidth = Math.min(PREVIEW_WIDTH, Math.max(24, Math.floor(width / 2)));
      // A 200-column terminal does not need a 154-column list; keep the preview near the
      // text instead of stranding it at the right edge.
      const leftWidth = Math.min(width - previewWidth - 2, 100);
      const left = state.list.render(leftWidth);
      const right = [
        ...(chosen.size ? [theme.fg("accent", `已选 ${chosen.size} 项，Enter 一起插入`)] : []),
        ...previewText(selected, previewWidth - 1, theme),
      ].slice(0, Math.max(left.length, 6));
      const height = Math.max(left.length, right.length);
      for (let index = 0; index < height; index += 1) {
        const leftLine = left[index] ?? "";
        const rightLine = right[index] ?? "";
        // Pad by visible width so ANSI-styled labels and CJK titles still line up.
        const padded = leftLine + " ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)));
        lines.push(`${padded}│ ${rightLine}`);
      }
      return lines;
    },
  };
}
