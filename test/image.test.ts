import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import test from "node:test";
import { detectImageMime, extensionForMime, saveTempImage } from "../src/image.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("image signatures map to mime types and extensions", () => {
  assert.equal(detectImageMime(png), "image/png");
  assert.equal(detectImageMime(jpeg), "image/jpeg");
  assert.equal(detectImageMime(gif), "image/gif");
  assert.equal(detectImageMime(webp), "image/webp");
  assert.equal(detectImageMime(Uint8Array.from([1, 2, 3])), null);
  assert.equal(extensionForMime("image/jpeg"), "jpg");
  assert.equal(extensionForMime("image/png"), "png");
});

test("clipboard bytes are saved as a readable temp image", async () => {
  const file = await saveTempImage({ bytes: png, mimeType: "image/png" });
  assert.match(file, /\.png$/);
  const bytes = await readFile(file);
  assert.deepEqual([...bytes], [...png]);
  await unlink(file);
});
