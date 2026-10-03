import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRemoteCompletion,
  hostAllowed,
  isAltSlash,
  parseKnownHosts,
  parseRemoteToken,
  parseSshConfigHosts,
  remoteEntries,
  remoteItems,
} from "../src/complete.ts";

test("remote token parses ssh destinations and ignores urls and drive letters", () => {
  const token = parseRemoteToken("/add-dir cap00:/data/re");
  assert.equal(token?.destination, "cap00");
  assert.equal(token?.listDir, "/data");
  assert.equal(token?.namePrefix, "re");
  assert.equal(token?.prefix, "cap00:/data/re");
  assert.equal(parseRemoteToken("see https://example.com/a"), null);
  assert.equal(parseRemoteToken("C:\\Users"), null);
  assert.equal(parseRemoteToken("user@cap00:")?.listDir, ".");
});

test("only configured ssh hosts complete", () => {
  const known = parseSshConfigHosts("Host cap00 gm00\nHost *.lab\nHost *\n");
  known.hosts.push(...parseKnownHosts("other.example.com ssh-ed25519 AAAA\n|1|hash ssh-ed25519 AAAA\n"));
  assert.equal(hostAllowed("cap00", known), true);
  assert.equal(hostAllowed("node.lab", known), true);
  assert.equal(hostAllowed("other.example.com", known), true);
  assert.equal(hostAllowed("random", known), false);
});

test("ls names become input completions and directories keep a slash", () => {
  const token = parseRemoteToken("cap00:/data/");
  assert.ok(token);
  const items = remoteItems(token, remoteEntries("relion/\nREADME\n./\n../\n", "rel"));
  assert.deepEqual(items.map((item) => item.value), ["cap00:/data/relion/"]);
  const draft = "/add-dir cap00:/data/";
  const applied = applyRemoteCompletion([draft], 0, draft.length, items[0]!.value, token.prefix, true);
  assert.equal(applied.lines[0], "/add-dir cap00:/data/relion/");
  assert.equal(applied.cursorCol, applied.lines[0]!.length);
});

test("alt slash is the emacs completion chord", () => {
  const esc = String.fromCharCode(27);
  assert.equal(isAltSlash(esc + "/"), true);
  assert.equal(isAltSlash(esc + "[47;3u"), true);
  assert.equal(isAltSlash(esc + "[27;3;47~"), true);
  assert.equal(isAltSlash(esc + "[47;3:3u"), false);
  assert.equal(isAltSlash("/"), false);
});
