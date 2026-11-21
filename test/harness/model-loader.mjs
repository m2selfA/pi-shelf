#!/usr/bin/env node
// Loads Shelf through the installed official Pi loader, with isolated agent state.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const host = process.argv[2];
if (!host) throw new Error('Expected installed Pi package root');
const implementation = ['index.ts', 'src/models.ts', 'src/model-context.ts', 'src/model-completion.ts', 'src/subagent-context.ts', 'test/harness/model-loader.mjs'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHashes = Object.fromEntries(await Promise.all(implementation.map(async path => [path, sha256(await readFile(path))])));
let assertions = 0;
const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
const ok = (actual, message) => { assertions++; assert.ok(actual, message); };
const agentDir = await mkdtemp(join(tmpdir(), 'pi-shelf-official-loader-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { loadExtensions } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')).href);
const { createEventBus } = await import(pathToFileURL(join(host, 'dist/core/event-bus.js')).href);
const { initTheme } = await import(pathToFileURL(join(host, 'dist/index.js')).href);
const { CombinedAutocompleteProvider, Editor } = await import(pathToFileURL(join(host, 'node_modules/@earendil-works/pi-tui/dist/index.js')).href);
initTheme('dark', false);
const events = createEventBus();
const entry = resolve('index.ts');
const loaded = await loadExtensions([entry], process.cwd(), events);
equal(loaded.errors, [], 'official extension loader reports no errors');
equal(loaded.warnings ?? [], [], 'no host peer warnings');
equal(loaded.extensions.length, 1, 'exactly one Shelf extension');
const extension = loaded.extensions[0];
ok(extension.commands.has('shelf'), 'Shelf command registered');
const fixture = { provider: 'fixture', id: 'gpt-test', name: 'GPT Test', reasoning: true };
loaded.runtime.getCommands = () => [];
loaded.runtime.getAllTools = () => [];
loaded.runtime.getActiveTools = () => [];
let provider;
const ctx = { cwd: agentDir, model: fixture, modelRegistry: { getAvailable: () => [fixture] }, isProjectTrusted: () => true, ui: {
  notify() {}, onTerminalInput: () => () => {}, addAutocompleteProvider: factory => { provider = factory(new CombinedAutocompleteProvider([], agentDir)); },
} };
for (const fn of extension.handlers.get('session_start') ?? []) await fn({}, ctx);
ok(provider, 'loaded module installed its autocomplete wrapper');
const text = 'use ^fixture/gpt-test:h';
const result = await provider.getSuggestions([text], 0, text.length, { force: true, signal: new AbortController().signal });
equal(result?.items[0]?.value, 'fixture/gpt-test:high', 'officially loaded module offers linked thinking');
equal(provider.applyCompletion([text], 0, text.length, result.items[0], result.prefix).lines[0], 'use ^fixture/gpt-test:high ');

const identity = text => text;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const editor = new Editor({ requestRender() {} }, theme);
editor.setAutocompleteProvider(provider);
let submissions = 0;
editor.onSubmit = () => { submissions++; };
const examples = [];
async function accept(input, value, expected) {
  editor.setText(input);
  editor.handleInput('\t');
  await editor.autocompleteRequestTask;
  if (editor.autocompleteList) {
    const suggestions = await provider.getSuggestions([input], 0, input.length, { force: true, signal: new AbortController().signal });
    const selected = suggestions.items.findIndex(item => item.value === value);
    ok(selected >= 0, `officially loaded candidate exists: ${value}`);
    editor.autocompleteList.setSelectedIndex(selected);
    editor.handleInput('\r');
  }
  equal(editor.getText(), expected, 'officially loaded editor preserves the natural-language model tag');
  examples.push({ input, output: editor.getText() });
}
await accept('请使用 ^fixture/gpt-test:h', 'fixture/gpt-test:high', '请使用 ^fixture/gpt-test:high ');
await accept('请让 reviewer 使用 ^fix', 'fixture/', '请让 reviewer 使用 ^fixture/');
await accept('请让 reviewer 使用 ^fixture/gpt-test:', 'fixture/gpt-test:high', '请让 reviewer 使用 ^fixture/gpt-test:high ');
await accept('请使用 ^fixture/gpt-t', 'fixture/gpt-test', '请使用 ^fixture/gpt-test ');
equal(submissions, 0, 'tag acceptance never submits a command');
for (const fn of extension.handlers.get('session_shutdown') ?? []) await fn({}, ctx);
for (const path of implementation) equal(sha256(await readFile(path)), fileHashes[path], `source stayed fixed while loading/testing: ${path}`);
console.log(JSON.stringify({ phase: 'official-pi-extension-loader', packageVersion: JSON.parse(await readFile('package.json', 'utf8')).version, hostVersion: JSON.parse(await readFile(join(host, 'package.json'), 'utf8')).version, loadedPath: extension.resolvedPath, assertions, indexSha256: fileHashes['index.ts'], fileHashes, examples, syntheticRegistry: true, currentInteractiveSessionReloaded: false }));
