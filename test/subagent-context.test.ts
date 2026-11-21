import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentContextClient, parseAgentCapabilities, type CompletionEventBus } from "../src/subagent-context.ts";

function bus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events: CompletionEventBus = {
    on(channel, handler) { const handlers = listeners.get(channel) ?? new Set(); handlers.add(handler); listeners.set(channel, handlers); return () => { handlers.delete(handler); }; },
    emit(channel, data) { for (const handler of [...(listeners.get(channel) ?? [])]) handler(data); },
  };
  return { events, listeners };
}
const result = (requestId: string) => ({ requestId, result: { details: { agentCapabilities: { agents: [
  { name: "reviewer", runner: { type: "pi" }, executable: true, aliases: ["rev"], model: { value: "fixture/gpt", thinking: "high" } },
  { name: "cli", runner: { type: "external-cli" }, executable: true },
] } } } });

test("capabilities projection is bounded, validated and explicitly policy-unknown", () => {
  assert.equal(parseAgentCapabilities({ result: { details: { agentCapabilities: { agents: [null, {}, { name: "x" }] } } } })?.length, 0);
  assert.equal(parseAgentCapabilities(result("x"))?.[0]?.policyChecked, false);
  assert.equal(parseAgentCapabilities({ isError: true }), undefined);
});

test("bridge only sends a read-only list, correlates responses and shares a cached request", async () => {
  const { events, listeners } = bus();
  let requests = 0;
  events.on("subagent:slash:request", raw => {
    const data = raw as { requestId: string; params: unknown };
    requests++;
    assert.deepEqual(data.params, { action: "list", agentScope: "both", options: { capabilities: true } });
    events.emit("subagent:slash:started", { requestId: data.requestId });
    events.emit("subagent:slash:response", result("unrelated"));
    queueMicrotask(() => events.emit("subagent:slash:response", result(data.requestId)));
  });
  const client = createSubagentContextClient(events, () => ({}));
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([client.get("rev", "key", signal), client.get("cli", "key", signal)]);
  assert.equal(a?.name, "reviewer");
  assert.equal(b?.runner, "external-cli");
  assert.equal(requests, 1);
  assert.equal((await client.get("reviewer", "key", signal))?.thinking, "high");
  assert.equal(requests, 1);
  assert.equal(listeners.get("subagent:slash:response")?.size, 0);
  client.dispose();
});

test("one cancelled reader detaches while a shared metadata request remains usable", async () => {
  const { events } = bus();
  let requestId = "";
  events.on("subagent:slash:request", raw => {
    requestId = (raw as { requestId: string }).requestId;
    events.emit("subagent:slash:started", { requestId });
  });
  const client = createSubagentContextClient(events, () => ({}));
  const controller = new AbortController();
  const cancelled = client.get("reviewer", "key", controller.signal);
  const survivor = client.get("reviewer", "key", new AbortController().signal);
  controller.abort();
  assert.equal(await cancelled, undefined);
  events.emit("subagent:slash:response", result(requestId));
  assert.equal((await survivor)?.name, "reviewer");
  client.dispose();
});

test("expired metadata reloads and an unresponsive bridge times out with cleanup", async () => {
  const { events, listeners } = bus();
  let requests = 0;
  let respond = true;
  let cancels = 0;
  events.on("subagent:slash:request", raw => {
    requests++;
    const requestId = (raw as { requestId: string }).requestId;
    events.emit("subagent:slash:started", { requestId });
    if (respond) queueMicrotask(() => events.emit("subagent:slash:response", result(requestId)));
  });
  events.on("subagent:slash:cancel", () => { cancels++; });
  const client = createSubagentContextClient(events, () => ({}), 0, 10);
  const signal = new AbortController().signal;
  await client.get("reviewer", "key", signal);
  await client.get("reviewer", "key", signal);
  assert.equal(requests, 2);
  respond = false;
  assert.equal(await client.get("reviewer", "key", signal), undefined);
  assert.equal(cancels, 1);
  assert.equal(listeners.get("subagent:slash:response")?.size, 0);
  client.dispose();
});

test("absent bridge returns immediately; disposal cancels a started request", async () => {
  const { events } = bus();
  const absent = createSubagentContextClient(events, () => ({}));
  assert.equal(await absent.get("reviewer", "key", new AbortController().signal), undefined);
  absent.dispose();
  let cancels = 0;
  events.on("subagent:slash:request", raw => events.emit("subagent:slash:started", { requestId: (raw as { requestId: string }).requestId }));
  events.on("subagent:slash:cancel", () => { cancels++; });
  const client = createSubagentContextClient(events, () => ({}));
  const pending = client.get("reviewer", "key", new AbortController().signal);
  client.dispose();
  assert.equal(await pending, undefined);
  assert.equal(cancels, 1);
});
