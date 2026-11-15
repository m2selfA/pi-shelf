import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createPicker, previewText } from "../src/picker.ts";
import type { Row } from "../src/match.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
} as never;

const tui = { requestRender() {} } as unknown as TUI;

const rows: Row[] = [
  { id: "a", category: "GitHub", title: "3dem/relion", value: "https://github.com/3dem/relion", tags: ["github"], source: "manual", uses: 4, created: "", updated: "2026-11-01", scope: "global" },
  { id: "b", category: "Shell", title: "awk first column", value: "awk '{print $1}' data.txt", tags: [], source: "manual", uses: 0, created: "", updated: "", scope: "global" },
  { id: "c", category: "Prompt", title: "review", value: "Review {{focus}}.\nSecond line.", tags: ["prompt"], source: "manual", uses: 1, created: "", updated: "", scope: "project" },
];

test("picker stays inside the supplied width at every terminal size", () => {
  for (const width of [120, 100, 90, 80, 70, 60, 50, 30]) {
    const picker = createPicker(tui, theme, { rows }, () => {});
    for (const line of picker.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width} overflowed: ${visibleWidth(line)} "${line}"`);
    }
  }
});

test("typing filters live, and Enter resolves the highlighted row", () => {
  let result: Row[] = [];
  const picker = createPicker(tui, theme, { rows }, (picked) => { result = picked; });
  picker.handleInput("a");
  picker.handleInput("w");
  const text = picker.render(100).join("\n");
  assert.ok(text.includes("awk first column"), "filtered list shows the matching row");
  assert.ok(!text.includes("3dem/relion"), "non-matching rows are gone");
  picker.handleInput("\r");
  assert.deepEqual(result.map((row) => row.id), ["b"]);
});

test("Tab marks rows and Enter inserts them together", () => {
  let result: Row[] = [];
  const picker = createPicker(tui, theme, { rows }, (picked) => { result = picked; });
  picker.handleInput("\t");
  picker.handleInput("\x1b[B");
  picker.handleInput("\t");
  assert.ok(picker.render(100).join("\n").includes("已选 2 项"));
  picker.handleInput("\r");
  // The list is ranked by usage, so the second row under "a" is "c", not "b".
  assert.deepEqual(result.map((row) => row.id), ["a", "c"]);
});

test("PageDown and PageUp move by one visible window", () => {
  const many: Row[] = Array.from({ length: 30 }, (_, index) => ({
    ...rows[0]!,
    id: `r${index}`,
    title: `row-${String(index).padStart(2, "0")}`,
    value: `value-${index}`,
    uses: 0,
  }));
  let result: Row[] = [];
  const picker = createPicker(tui, theme, { rows: many, multi: false }, (picked) => { result = picked; });
  picker.handleInput("\x1b[6~");
  picker.handleInput("\r");
  assert.equal(result[0]?.id, "r9", "PageDown jumps one window minus one row");
  const back = createPicker(tui, theme, { rows: many, multi: false }, (picked) => { result = picked; });
  back.handleInput("\x1b[6~");
  back.handleInput("\x1b[5~");
  back.handleInput("\r");
  assert.equal(result[0]?.id, "r0", "PageUp returns to the previous window");
});

test("Tab is ignored when multi-select is off", () => {
  let result: Row[] = [];
  const picker = createPicker(tui, theme, { rows, multi: false }, (picked) => { result = picked; });
  picker.handleInput("\t");
  picker.handleInput("\r");
  assert.deepEqual(result.map((row) => row.id), ["a"]);
});

test("moving the highlight repaints the preview", () => {
  let renders = 0;
  const picker = createPicker({ requestRender: () => { renders += 1; } } as unknown as TUI, theme, { rows }, () => {});
  picker.handleInput("\x1b[B");
  assert.ok(renders > 0, "down arrow must request a render so the preview changes");
});

test("Esc cancels without a selection", () => {
  let result: Row[] | undefined;
  const picker = createPicker(tui, theme, { rows }, (picked) => { result = picked; });
  picker.handleInput("\x1b");
  assert.deepEqual(result, []);
});

test("preview shows the whole multi-line value and its variables", () => {
  const lines = previewText(rows[2], 40, theme).join("\n");
  assert.ok(lines.includes("Review {{focus}}."));
  assert.ok(lines.includes("Second line."));
  assert.ok(lines.includes("变量 focus"));
  assert.ok(lines.includes("仓库"));
});
