import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRemoteCompletion,
  hostAllowed,
  isAltSlash,
  localPathItems,
  parseLocalDrivePath,
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

test("Windows drive prefixes parse and format local entries", () => {
  const token = parseLocalDrivePath("E:/in");
  assert.deepEqual(token, { prefix: "E:/in", directory: "E:/", namePrefix: "in" });
  assert.equal(parseLocalDrivePath("cap00:/data"), null);
  assert.deepEqual(
    localPathItems(token!, [
      { name: "README.md", dir: false },
      { name: "inter", dir: true },
      { name: "input", dir: true },
      { name: "other", dir: true },
    ]),
    [
      { value: "E:/input/", label: "input/" },
      { value: "E:/inter/", label: "inter/" },
    ],
  );
});

test("path listings hide dotfiles, filter directories, and fuzzy-rank Tab matches", () => {
  const token = parseLocalDrivePath("E:/nt");
  assert.deepEqual(
    localPathItems(token!, [
      { name: "input", dir: true },
      { name: "inter", dir: true },
      { name: "notes", dir: false },
      { name: ".hidden", dir: true },
    ], { directoriesOnly: true, fuzzy: true }),
    [
      { value: "E:/inter/", label: "inter/" },
      { value: "E:/input/", label: "input/" },
    ],
  );
  const hidden = parseLocalDrivePath("E:/.");
  assert.deepEqual(
    localPathItems(hidden!, [{ name: ".pi", dir: true }, { name: "plain", dir: true }], { directoriesOnly: true }),
    [{ value: "E:/.pi/", label: ".pi/" }],
  );
  assert.deepEqual(
    remoteEntries("notes\ninter/\ninput/\n.hidden/\n", "nt", { directoriesOnly: true, fuzzy: true }),
    [{ name: "inter", dir: true }, { name: "input", dir: true }],
  );
});

test("only configured ssh hosts complete", () => {
  const known = parseSshConfigHosts("Host cap00 gm00\nHost *.lab\nHost *\n");
  const fromKnownHosts = parseKnownHosts("other.example.com ssh-ed25519 AAAA\n*.internal ssh-ed25519 AAAA\n|1|hash ssh-ed25519 AAAA\n");
  known.hosts.push(...fromKnownHosts.hosts);
  known.patterns.push(...fromKnownHosts.patterns);
  assert.equal(hostAllowed("cap00", known), true);
  assert.equal(hostAllowed("node.lab", known), true);
  assert.equal(hostAllowed("other.example.com", known), true);
  // A wildcard in known_hosts must match too, not only an exact name.
  assert.equal(hostAllowed("gpu1.internal", known), true);
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

test("a multi-line value becomes one editor line per row", () => {
    const applied = applyRemoteCompletion(["@tpl"], 0, 4, "Review:\nstep 1\nstep 2", "@tpl", false);
    assert.deepEqual(applied.lines, ["Review:", "step 1", "step 2 "]);
    assert.equal(applied.cursorLine, 2);
    assert.equal(applied.cursorCol, 7);
    // CRLF from a Windows-authored template must not leave a stray carriage return.
    const crlf = applyRemoteCompletion(["@tpl"], 0, 4, "a\r\nb", "@tpl", false);
    assert.deepEqual(crlf.lines, ["a", "b "]);
    assert.equal(crlf.lines.some((line) => line.includes("\r")), false);
});

test("a single-line value still completes inline", () => {
    const applied = applyRemoteCompletion(["see @rel"], 0, 8, "https://github.com/3dem/relion", "@rel", false);
    assert.deepEqual(applied.lines, ["see https://github.com/3dem/relion "]);
    assert.equal(applied.cursorLine, 0);
    assert.equal(applied.cursorCol, 35);
    // Directories keep no trailing space so the user can keep completing.
    const dir = applyRemoteCompletion(["cap00:/da"], 0, 9, "cap00:/data/", "cap00:/da", true);
    assert.deepEqual(dir.lines, ["cap00:/data/"]);
});

test("alt slash is the emacs completion chord", () => {
  const esc = String.fromCharCode(27);
  assert.equal(isAltSlash(esc + "/"), true);
  assert.equal(isAltSlash(esc + "[47;3u"), true);
  assert.equal(isAltSlash(esc + "[27;3;47~"), true);
  assert.equal(isAltSlash(esc + "[47;3:3u"), false);
  assert.equal(isAltSlash("/"), false);
});
