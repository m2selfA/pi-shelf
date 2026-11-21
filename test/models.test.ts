import assert from "node:assert/strict";
import test from "node:test";
import { modelCatalog, modelWithThinking, rankedModels, supportedThinkingLevels, type ModelLike } from "../src/models.ts";
import { commandAt, modelInputContext } from "../src/model-context.ts";
import { createModelCompletionProvider } from "../src/model-completion.ts";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const models: ModelLike[] = [
  { provider: "sub2api", id: "gpt-fixture", name: "GPT Fixture", reasoning: true },
  { provider: "智谱", id: "glm-fixture", reasoning: true },
  { provider: "ollama@gamma", id: "qwen:latest", reasoning: false },
  { provider: "openrouter", id: "owner/model:free", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", low: null } },
  { provider: "other", id: "gpt-fixture", reasoning: false },
];
const noop: AutocompleteProvider = { getSuggestions: async () => null, applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }) };
const query = (provider: AutocompleteProvider, text: string, col = text.length) => provider.getSuggestions([text], 0, col, { force: true, signal: new AbortController().signal });
const create = (extra: Partial<Parameters<typeof createModelCompletionProvider>[0]> = {}) => createModelCompletionProvider({ current: noop, getModels: () => models, getRunCommands: () => ["run", "run:1"], ...extra });

test("caret model mentions trigger without Tab and preserve the label through every stage", async () => {
  const provider = create();
  const firstText = "让 reviewer 使用 ^";
  const first = await provider.getSuggestions([firstText], 0, firstText.length, { force: false, signal: new AbortController().signal });
  assert.ok(first?.items.some(item => item.value === "sub2api/"));
  assert.ok(!first?.items.some(item => item.value === "sub2api"), "tag browsing offers provider/ instead of a partial provider-only tag");
  const browse = first!.items.find(item => item.value === "sub2api/")!;
  const step1 = provider.applyCompletion([firstText], 0, firstText.length, browse, first!.prefix);
  assert.equal(step1.lines[0], "让 reviewer 使用 ^sub2api/");
  const second = await query(provider, step1.lines[0]!);
  const model = second!.items.find(item => item.value === "sub2api/gpt-fixture:")!;
  const step2 = provider.applyCompletion(step1.lines, 0, step1.cursorCol, model, second!.prefix);
  assert.equal(step2.lines[0], "让 reviewer 使用 ^sub2api/gpt-fixture:");
  const third = await query(provider, step2.lines[0]!);
  const high = third!.items.find(item => item.value.endsWith(":high"))!;
  const step3 = provider.applyCompletion(step2.lines, 0, step2.cursorCol, high, third!.prefix);
  assert.equal(step3.lines[0], "让 reviewer 使用 ^sub2api/gpt-fixture:high ");
});

test("caret model mentions retain nested IDs, trailing prose and other provider tags", async () => {
  const provider = create();
  const text = "分别用 ^sub2api/gpt-fixture:low 和 ^openrouter/owner/model:free:h，检查代码";
  const col = text.indexOf("，");
  const result = await query(provider, text, col);
  const high = result!.items.find(item => item.value.endsWith(":high"))!;
  const output = provider.applyCompletion([text], 0, col, high, result!.prefix);
  assert.equal(output.lines[0], "分别用 ^sub2api/gpt-fixture:low 和 ^openrouter/owner/model:free:high，检查代码");
  assert.equal(output.cursorCol, output.lines[0]!.indexOf("，"));
  const plainText = "请使用 ^sub2api/gpt-fixture";
  const plainRows = await query(provider, plainText);
  const plain = plainRows!.items.find(item => item.value === "sub2api/gpt-fixture")!;
  assert.equal(provider.applyCompletion([plainText], 0, plainText.length, plain, plainRows!.prefix).lines[0], plainText + " ");
  const unicodeText = "让 worker 使用 ^智谱/glm-f";
  const unicodeRows = await query(provider, unicodeText);
  const unicode = unicodeRows!.items.find(item => item.value === "智谱/glm-fixture")!;
  assert.equal(provider.applyCompletion([unicodeText], 0, unicodeText.length, unicode, unicodeRows!.prefix).lines[0], "让 worker 使用 ^智谱/glm-fixture ");
  assert.equal(modelInputContext("x^2", 3, false), undefined);
  assert.equal(modelInputContext("&github", 7, false), undefined);
});

test("model identity retains Unicode, provider duplicates, nested ids and colons", () => {
  assert.equal(modelCatalog([...models, models[0]!]).length, 5);
  assert.equal(modelWithThinking("ollama@gamma/qwen:latest", models), undefined);
  assert.equal(modelWithThinking("openrouter/owner/model:free:h", models)?.query, "h");
  assert.equal(rankedModels(models, "gpt").length, 2);
  assert.deepEqual(rankedModels(models, "openrouter/owner/").map(m => m.provider), ["openrouter"]);
});

test("thinking choices follow host metadata, null mappings and ceiling", () => {
  assert.deepEqual(supportedThinkingLevels(models[0]!), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(supportedThinkingLevels(models[2]!), ["off"]);
  assert.deepEqual(supportedThinkingLevels(models[3]!, "medium"), ["off", "minimal", "medium"]);
  assert.ok(supportedThinkingLevels(models[3]!).includes("max"));
});

test("context recognizes owned run commands and the model value span", () => {
  const text = "/run reviewer[model=sub2api/gpt:h,output=a] task";
  const col = text.indexOf(",output");
  const ctx = modelInputContext(text, col, true, ["run"]);
  assert.equal(ctx?.agent, "reviewer");
  assert.equal(ctx?.query, "sub2api/gpt:h");
  assert.equal(ctx?.end, col);
  assert.equal(modelInputContext("/run:1 rev", 10, true, ["run:1"])?.kind, "run-agent");
  assert.equal(commandAt("/skill:review foo")?.name, "skill:review");
});

test("ordinary prose waits for explicit completion; paths and native commands retain ownership", () => {
  for (const text of ["use gpt", "./gpt", "E:/gpt", "https://gpt", "@gpt", "/add-dir sub", "/model sub", "/remove-dir sub"]) {
    assert.equal(modelInputContext(text, text.length, false), undefined);
  }
  for (const text of ["./gpt", "E:/gpt", "https://gpt", "@gpt", "/add-dir sub", "/model sub", "/remove-dir sub"]) {
    assert.equal(modelInputContext(text, text.length, true), undefined);
  }
  assert.equal(modelInputContext("use :model:gpt", 14, false)?.kind, "model");
});

test("linked run completion navigates provider, model and thinking", async () => {
  const provider = create();
  const start = "/run reviewer[model=";
  const first = await query(provider, start);
  const browse = first?.items.find(item => item.value === "sub2api/");
  assert.ok(browse);
  const step1 = provider.applyCompletion([start], 0, start.length, browse, first!.prefix);
  assert.equal(step1.lines[0], start + "sub2api/");
  const second = await query(provider, step1.lines[0]!);
  const model = second?.items.find(item => item.value === "sub2api/gpt-fixture:");
  assert.ok(model);
  const step2 = provider.applyCompletion(step1.lines, 0, step1.cursorCol, model, second!.prefix);
  const third = await query(provider, step2.lines[0]!);
  const high = third?.items.find(item => item.value === "sub2api/gpt-fixture:high");
  assert.ok(high);
  const step3 = provider.applyCompletion(step2.lines, 0, step2.cursorCol, high, third!.prefix);
  assert.equal(step3.lines[0], "/run reviewer[model=sub2api/gpt-fixture:high] ");
  assert.ok(!third!.items.some(item => item.value.endsWith(":xhigh")));
});

test("completion replaces the whole value at a middle cursor and preserves adjacent fields", async () => {
  const provider = create();
  const text = "/run reviewer[model=sub2api/gpt-fixture:high,output=review.md] Check";
  const col = text.indexOf(":high") + 2;
  const result = await query(provider, text, col);
  const high = result?.items.find(item => item.value.endsWith(":high"));
  assert.ok(high);
  assert.equal(provider.applyCompletion([text], 0, col, high, result!.prefix).lines[0], text);
});

test("external and restricted roles never receive Pi provider model ids", async () => {
  for (const row of [{ name: "reviewer", runner: "external-cli" as const, executable: true }, { name: "reviewer", runner: "pi" as const, executable: false }]) {
    const provider = create({ getAgent: async () => row });
    assert.equal(await query(provider, "/run reviewer[model="), null);
  }
});

test("known policy projection filters models and high levels", async () => {
  const provider = create({ getAgent: async () => ({ name: "reviewer", runner: "pi", executable: true, allowedModels: ["sub2api/gpt-fixture"], maxThinking: "low", policyChecked: true }) });
  const result = await query(provider, "/run reviewer[model=sub2api/gpt-fixture:");
  assert.deepEqual(result?.items.map(item => item.value.split(":").pop()), ["off", "minimal", "low"]);
});

test("native whole-argument candidates retain their own replacement prefix", async () => {
  const native: AutocompleteProvider = {
    getSuggestions: async (_lines, _row, _col, opts) => opts.force ? null : { prefix: "run --model gpt", items: [{ value: "reset --model native", label: "native reset" }] },
    applyCompletion: (lines, row, col, item, prefix) => ({ lines: [lines[row]!.slice(0, col - prefix.length) + item.value], cursorLine: row, cursorCol: col - prefix.length + item.value.length }),
  };
  const provider = create({ current: native });
  const text = "/probe run --model gpt";
  // The native result replaces the complete argument sequence; model rows own only gpt.
  const result = await query(provider, text);
  const item = result?.items.find(item => item.label === "native reset");
  assert.ok(item);
  const expected = native.applyCompletion([text], 0, text.length, item, "run --model gpt");
  assert.deepEqual(provider.applyCompletion([text], 0, text.length, item, result!.prefix), expected);
});

test("removed model and changed editor text invalidate a selected row", async () => {
  let catalog = [...models];
  const provider = create({ getModels: () => catalog });
  const text = "use :model:sub2api/gpt-fixture:h";
  const result = await query(provider, text);
  const item = result!.items[0]!;
  const changed = text + "i";
  assert.equal(provider.applyCompletion([changed], 0, changed.length, item, result!.prefix).lines[0], changed);
  catalog = [];
  assert.equal(provider.applyCompletion([text], 0, text.length, item, result!.prefix).lines[0], text);
});

test("quoted model flags preserve quoting and following arguments", async () => {
  const provider = create();
  const text = '/probe --model="sub2api/gpt-fixture:h" --keep';
  const col = text.indexOf('" --keep');
  const result = await query(provider, text, col);
  const high = result?.items.find(item => item.value.endsWith(":high"));
  assert.ok(high);
  assert.equal(provider.applyCompletion([text], 0, col, high, result!.prefix).lines[0], '/probe --model="sub2api/gpt-fixture:high" --keep');
});

test("Shelf and directory invocation suffixes retain forced path completion", async () => {
  const calls: Array<boolean | undefined> = [];
  const native: AutocompleteProvider = { ...noop, getSuggestions: async (_lines, _row, _col, opts) => { calls.push(opts.force); return null; } };
  const provider = create({ current: native });
  await query(provider, "/shelf:2 unknown");
  await query(provider, "/add-dir:2 src");
  assert.deepEqual(calls, [true, true]);
});

test("only complete choices are recorded and stale thinking shortcuts are filtered", async () => {
  const accepted: Array<[string, string]> = [];
  const scores = new Map([["sub2api/gpt-fixture:high", 10], ["sub2api/gpt-fixture:max", 100], ["missing/model:high", 100]]);
  const provider = create({ accepted: (group, value) => accepted.push([group, value]), scores: group => group === "model" ? scores : new Map() });
  const text = "/run reviewer[model=";
  const result = await query(provider, text);
  assert.equal(result?.items[0]?.value, "sub2api/gpt-fixture:high");
  assert.ok(!result?.items.some(item => item.value === "sub2api/gpt-fixture:max"));
  const browse = result!.items.find(item => item.value === "sub2api/")!;
  provider.applyCompletion([text], 0, text.length, browse, result!.prefix);
  assert.equal(accepted.length, 0);
  provider.applyCompletion([text], 0, text.length, result!.items[0]!, result!.prefix);
  assert.deepEqual(accepted, [["model", "sub2api/gpt-fixture:high"]]);
});

test("an unrelated command named run is not treated as a subagent command", async () => {
  const provider = create({ getRunCommands: () => [] });
  assert.equal(await query(provider, "/run reviewer[model="), null);
});

test("aborted requests never publish candidates and empty registry retains native results", async () => {
  const provider = create();
  const signal = AbortSignal.abort();
  assert.equal(await provider.getSuggestions(["use gpt"], 0, 7, { force: true, signal }), null);
  const native: AutocompleteProvider = { ...noop, getSuggestions: async () => ({ prefix: "gpt", items: [{ value: "gpt-file", label: "file" }] }) };
  assert.equal((await query(create({ current: native, getModels: () => [] }), "use gpt"))?.items[0]?.label, "file");
});
