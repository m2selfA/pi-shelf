#!/usr/bin/env node
// Real Shelf extension + Pi Editor, synthetic read-only model/agent registry.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { initTheme } from '@earendil-works/pi-coding-agent';

const tui = process.argv[2] ? await import(pathToFileURL(join(process.argv[2], 'dist/index.js')).href) : await import('@earendil-works/pi-tui');
const { CombinedAutocompleteProvider, Editor } = tui;
const agentDir = await mkdtemp(join(tmpdir(), 'pi-shelf-models-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, 'files'));
await writeFile(join(agentDir, 'files', 'gpt-file'), 'fixture');
const handlers = new Map();
const listeners = new Map();
let wrapped;
let terminal;
let submissions = 0;
const models = [
  { provider: 'sub2api', id: 'gpt-fixture', name: 'GPT Fixture', reasoning: true },
  { provider: '智谱', id: 'glm-fixture', reasoning: true },
  { provider: 'ollama@gamma', id: 'qwen:latest', reasoning: false },
];
const base = new CombinedAutocompleteProvider([
  { name: 'run', getArgumentCompletions: prefix => ['reviewer', 'worker', 'claude-code'].filter(name => name.startsWith(prefix)).map(value => ({ value, label: value })) },
  { name: 'model', getArgumentCompletions: prefix => models.filter(m => m.id.includes(prefix)).map(m => ({ value: `${m.provider}/${m.id}`, label: m.id })) },
], join(agentDir, 'files'));
// Mimic an inner MCP mention provider; Shelf must preserve its trigger and row.
base.triggerCharacters = ['&'];
const nativeSuggestions = base.getSuggestions.bind(base);
base.getSuggestions = async (lines, row, col, opts) => {
  if ((lines[row] ?? '').slice(0, col).endsWith('&git')) return { prefix: '&git', items: [{ value: '[&github](mcp://github)', label: '&github' }] };
  return nativeSuggestions(lines, row, col, opts);
};
const fakePi = {
  on: (event, handler) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
  registerCommand() {}, registerShortcut() {}, registerTool() {}, getAllTools: () => [], getActiveTools: () => [],
  getCommands: () => [{ name: 'run', source: 'extension', sourceInfo: { source: 'npm:pi-subagents' } }],
  events: {
    on: (name, handler) => { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
    emit: (name, data) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
  },
};
fakePi.events.on('subagent:slash:request', data => {
  if (data.params.action !== 'list') return;
  assert.equal(data.params.options.capabilities, true);
  fakePi.events.emit('subagent:slash:started', { requestId: data.requestId });
  queueMicrotask(() => fakePi.events.emit('subagent:slash:response', { requestId: data.requestId, result: { details: { agentCapabilities: { agents: [
    { name: 'reviewer', executable: true, runner: { type: 'pi' } },
    { name: 'worker', executable: true, runner: { type: 'pi' } },
    { name: 'claude-code', executable: true, runner: { type: 'external-cli' } },
  ] } } } }));
});
initTheme('dark', false);
const { default: extension } = await import('../../index.ts');
extension(fakePi);
const ctx = { cwd: join(agentDir, 'files'), model: models[0], modelRegistry: { getAvailable: () => models }, isProjectTrusted: () => true, ui: {
  addAutocompleteProvider: factory => { wrapped = factory(base); }, onTerminalInput: handler => { terminal = handler; }, notify() {},
} };
for (const handler of handlers.get('session_start')) await handler({}, ctx);
let assertions = 0;
const equal = (a, b, reason) => { assertions++; assert.deepEqual(a, b, reason); };
const ok = (a, reason) => { assertions++; assert.ok(a, reason); };
const options = { force: true, signal: new AbortController().signal };
const suggestions = text => wrapped.getSuggestions([text], 0, text.length, options);
const insert = async (text, value) => {
  const result = await suggestions(text);
  const item = result?.items.find(item => item.value === value);
  ok(item, `found ${value}`);
  return wrapped.applyCompletion([text], 0, text.length, item, result.prefix).lines[0];
};
equal(terminal('\x1b/'), { data: '\t' }, 'Alt+/ remains Tab');
equal((await suggestions('/run rev')).items.map(item => item.label), ['reviewer', 'reviewer · 配置本次模型'], 'native agent rows and setup action coexist');
let text = await insert('/run rev', 'reviewer[model=');
equal(text, '/run reviewer[model=', 'agent action starts configuration');
text = await insert(text, 'sub2api/');
equal(text, '/run reviewer[model=sub2api/', 'provider navigation adds no space');
text = await insert(text, 'sub2api/gpt-fixture:');
equal(text, '/run reviewer[model=sub2api/gpt-fixture:', 'model navigation enters thinking');
text = await insert(text, 'sub2api/gpt-fixture:high');
equal(text, '/run reviewer[model=sub2api/gpt-fixture:high] ', 'thinking closes only the inline config');
equal(await suggestions('/run claude-code[model='), null, 'external role does not get Pi models');
const marker = await insert('请使用 :model:sub2api/gpt-fixture:h', 'sub2api/gpt-fixture:high');
equal(marker, '请使用 sub2api/gpt-fixture:high ', 'prose marker is removed');
equal(await insert('/probe --provider=智', '智谱'), '/probe --provider=智谱 ', 'Unicode provider flag');
const identity = text => text;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const editor = new Editor({ requestRender() {} }, theme);
editor.onSubmit = () => { submissions++; };
editor.setAutocompleteProvider(wrapped);
editor.setText('/run reviewer[model=sub2api/gpt-fixture:h');
editor.handleInput('\t');
await editor.autocompleteRequestTask;
equal(editor.getText(), '/run reviewer[model=sub2api/gpt-fixture:high] ', 'real Editor Tab applies one strength candidate');
equal(submissions, 0, 'completion does not submit a slash command');
const plain = await suggestions('/run reviewer[model=ollama@gamma/qwen:latest:');
equal(plain.items.map(item => item.value), ['ollama@gamma/qwen:latest:off'], 'colon in model id is preserved');
editor.setText('/run reviewer[model=');
editor.handleInput('\t');
await editor.autocompleteRequestTask;
ok(editor.autocompleteList, 'real Editor opens linked candidate list');
editor.handleInput('\x1b');
equal(editor.getText(), '/run reviewer[model=', 'Escape dismisses without changing draft');
editor.setText('/run reviewer[model=sub2api/gpt-fixture:');
editor.handleInput('\t');
await editor.autocompleteRequestTask;
const strengths = await suggestions(editor.getText());
editor.autocompleteList.setSelectedIndex(strengths.items.findIndex(item => item.value.endsWith(':high')));
editor.handleInput('\r');
equal(editor.getText(), '/run reviewer[model=sub2api/gpt-fixture:high] ', 'Enter accepts a strength from the real dropdown');
equal(submissions, 0, 'Enter in the strength dropdown does not launch /run');
// Natural typing must trigger a query without manually pressing Tab. Observe
// the real debounced provider call rather than sleeping or bypassing its trigger.
let mentionRequested;
let mentionTimer;
const naturalQuery = new Promise((resolve, reject) => {
  mentionRequested = resolve;
  mentionTimer = setTimeout(() => reject(new Error('Caret did not naturally trigger completion')), 3000);
});
editor.setAutocompleteProvider({ ...wrapped, async getSuggestions(...args) {
  const result = await wrapped.getSuggestions(...args);
  if (args[0][args[1]].slice(0, args[2]).endsWith('^')) mentionRequested(result);
  return result;
} });
editor.setText('让 reviewer 使用 ');
editor.handleInput('^');
const naturalResult = await naturalQuery;
clearTimeout(mentionTimer);
await editor.autocompleteRequestTask;
ok(naturalResult?.items.some(item => item.value === 'sub2api/'), 'typing caret opens model/provider choices naturally');
ok(editor.autocompleteList, 'real editor displays natural caret choices');
equal(editor.getText(), '让 reviewer 使用 ^', 'opening tag choices does not change the draft');
editor.handleInput('\x1b');
editor.setAutocompleteProvider(wrapped);
let mention = await insert('请使用 ^', 'sub2api/');
equal(mention, '请使用 ^sub2api/', 'caret remains after provider browsing');
mention = await insert(mention, 'sub2api/gpt-fixture:');
equal(mention, '请使用 ^sub2api/gpt-fixture:', 'caret remains after model selection');
mention = await insert(mention, 'sub2api/gpt-fixture:high');
equal(mention, '请使用 ^sub2api/gpt-fixture:high ', 'exact model/thinking tag is inserted');
ok(wrapped.triggerCharacters.includes('&'), 'inner MCP mention trigger remains installed');
const mcpText = '使用 &git';
const mcp = await wrapped.getSuggestions([mcpText], 0, mcpText.length, { ...options, force: false });
equal(mcp?.items[0]?.value, '[&github](mcp://github)', 'MCP candidates keep their owner');
equal(wrapped.applyCompletion([mcpText], 0, mcpText.length, mcp.items[0], mcp.prefix), base.applyCompletion([mcpText], 0, mcpText.length, mcp.items[0], mcp.prefix), 'MCP item insertion is unchanged');
equal(submissions, 0, 'tag completion does not submit');

// Optional installed-package roundtrip. Intercept only the bridge event, so the
// real /run handler parses and validates the generated command but launches no child.
if (process.env.PI_SHELF_SUBAGENTS_ROOT) {
  // Managed packages intentionally omit host peers. Match Pi's peer mapping in
  // this standalone test process; do not install copies into the plugin.
  const hostRoot = process.env.PI_SHELF_HOST_ROOT;
  if (!hostRoot) throw new Error('PI_SHELF_HOST_ROOT is required for installed-subagents verification');
  const resolveHost = createRequire(join(hostRoot, 'package.json'));
  const aliases = {
    '@earendil-works/pi-coding-agent': join(hostRoot, 'dist/index.js'),
    '@earendil-works/pi-ai': join(hostRoot, 'dist/core/extensions/pi-ai-extension-view.js'),
    '@earendil-works/pi-tui': resolveHost.resolve('@earendil-works/pi-tui'),
    '@earendil-works/pi-agent-core': join(hostRoot, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
    'typebox': resolveHost.resolve('typebox'),
    'typebox/compile': resolveHost.resolve('typebox/compile'),
    'typebox/value': resolveHost.resolve('typebox/value'),
  };
  const hook = registerHooks({ resolve(specifier, context, next) { return aliases[specifier] ? { url: pathToFileURL(aliases[specifier]).href, shortCircuit: true } : next(specifier, context); } });
  const { registerSlashCommands } = await import(pathToFileURL(join(process.env.PI_SHELF_SUBAGENTS_ROOT, 'src/slash/slash-commands.js')).href);
  const commands = new Map();
  let captured;
  const state = { baseCwd: ctx.cwd, foregroundControls: new Map(), lastUiContext: ctx };
  const subPi = { ...fakePi, registerCommand: (name, def) => commands.set(name, def), sendMessage() {} };
  const registered = registerSlashCommands(subPi, state, { workflowScriptsDisabled: true });
  const off = fakePi.events.on('subagent:slash:request', data => {
    if (data.params.action === 'list') return;
    captured = data.params;
    fakePi.events.emit('subagent:slash:started', { requestId: data.requestId });
    queueMicrotask(() => fakePi.events.emit('subagent:slash:response', { requestId: data.requestId, result: { content: [], details: { results: [] } } }));
  });
  const commandCtx = { ...ctx, hasUI: false, sessionManager: { getSessionFile: () => undefined }, ui: { ...ctx.ui, setToolsExpanded() {}, setStatus() {} } };
  await commands.get('run').handler('reviewer[model=sub2api/gpt-fixture:high,output=review.md] Check the diff', commandCtx);
  await new Promise(resolve => setImmediate(resolve));
  equal(captured?.model, 'sub2api/gpt-fixture:high', 'installed /run handler preserves serialized model and thinking');
  equal(captured?.task, 'Check the diff', 'installed /run handler preserves task');
  equal(captured?.output, 'review.md', 'installed /run handler preserves adjacent output field');
  off();
  registered.dispose();
  hook.deregister();
}
const modelNative = await suggestions('/model gpt');
ok(modelNative.items.some(item => item.value === 'sub2api/gpt-fixture'), 'native model command works under forced Tab');
for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, ctx);
console.log(JSON.stringify({ phase: 'production-model-completion-harness', assertions, packageVersion: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version, editorPackage: process.argv[2] ?? 'development pi-tui', result: text, tagResult: mention, childLaunches: 0, providerRequests: 0 }));
