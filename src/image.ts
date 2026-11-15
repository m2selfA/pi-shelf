import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getNativeClipboard } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

export type ClipboardImage = { bytes: Uint8Array; mimeType: string };

export function detectImageMime(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.slice(0, 12));
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && head.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function extensionForMime(mimeType: string) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "png";
}

export async function saveTempImage(image: ClipboardImage): Promise<string> {
  const file = join(tmpdir(), `pi-shelf-image-${randomUUID()}.${extensionForMime(image.mimeType)}`);
  await writeFile(file, Buffer.from(image.bytes));
  return file;
}

async function runPowerShell(script: string, timeout = 8000) {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function readClipboardImageWindows(): Promise<ClipboardImage | null> {
  const file = join(tmpdir(), `pi-shelf-clip-${randomUUID()}.png`);
  const quoted = file.replace(/'/g, "''");
  try {
    const status = await runPowerShell(
      `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img=[System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${quoted}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }`,
    );
    if (status !== "ok") return null;
    const bytes = await readFile(file);
    return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
  } catch {
    return null;
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

async function readClipboardImageLinux(): Promise<ClipboardImage | null> {
  for (const [command, args] of [["wl-paste", ["--type", "image/png", "--no-newline"]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]] as Array<[string, string[]]>) {
    try {
      const { stdout } = await execFileAsync(command, args, { encoding: "buffer", maxBuffer: 40 * 1024 * 1024 } as never);
      const bytes = new Uint8Array(stdout as unknown as Buffer);
      const mimeType = detectImageMime(bytes);
      if (mimeType) return { bytes, mimeType };
    } catch {
      // try the next clipboard tool
    }
  }
  return null;
}

async function readClipboardImageMac(): Promise<ClipboardImage | null> {
  const file = join(tmpdir(), `pi-shelf-clip-${randomUUID()}.png`);
  try {
    await execFileAsync("osascript", [
      "-e",
      `set f to open for access POSIX file "${file.replace(/"/g, '\\"')}" with write permission`,
      "-e",
      "write (the clipboard as «class PNGf») to f",
      "-e",
      "close access f",
    ], { timeout: 5000 });
    const bytes = await readFile(file);
    return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
  } catch {
    return null;
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

/** Clipboard image in the same spirit as Pi's Ctrl+V: bytes, never a text fallback. */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  try {
    const native = await getNativeClipboard()?.getImage();
    if (native?.length) {
      const bytes = new Uint8Array(native);
      const mimeType = detectImageMime(bytes);
      if (mimeType) return { bytes, mimeType };
    }
  } catch {
    // Native clipboard is unavailable in some runtimes; use the OS helper below.
  }
  if (process.platform === "win32") return readClipboardImageWindows();
  if (process.platform === "darwin") return readClipboardImageMac();
  return readClipboardImageLinux();
}

function imageHash(image: ClipboardImage) {
  return Buffer.from(image.bytes).toString("base64").slice(0, 128);
}

async function screenshotWindows(): Promise<string | null> {
  const before = await readClipboardImage();
  const beforeHash = before ? imageHash(before) : "";
  let launched = false;
  try {
    await execFileAsync("cmd.exe", ["/d", "/s", "/c", 'start "" "ms-screenclip:"'], { timeout: 3000 });
    launched = true;
  } catch {
    // fall through to the full-screen capture
  }
  if (launched) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const next = await readClipboardImage();
      if (next && (beforeHash === "" || imageHash(next) !== beforeHash)) return saveTempImage(next);
    }
    return null;
  }
  // Full-screen fallback for systems where the snipping overlay is unavailable.
  const file = join(tmpdir(), `pi-shelf-shot-${randomUUID()}.png`);
  const quoted = file.replace(/'/g, "''");
  try {
    await runPowerShell(
      `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap([System.Windows.Forms.SystemInformation]::VirtualScreen.Width,[System.Windows.Forms.SystemInformation]::VirtualScreen.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen([System.Windows.Forms.SystemInformation]::VirtualScreen.X,[System.Windows.Forms.SystemInformation]::VirtualScreen.Y,0,0,$b.Size); $b.Save('${quoted}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      10000,
    );
    return file;
  } catch {
    return null;
  }
}

let screenshotCache: { at: number; path: string | null } | undefined;

/** Launch the platform screenshot UI and return a PNG path, or null when cancelled. */
export async function captureScreenshot(): Promise<string | null> {
  // The completion provider may be called again while the picker is open; reuse the
  // capture for a few seconds instead of launching the overlay repeatedly.
  if (screenshotCache && Date.now() - screenshotCache.at < 5000) return screenshotCache.path;
  const path = await captureScreenshotUncached();
  screenshotCache = { at: Date.now(), path };
  return path;
}

async function captureScreenshotUncached(): Promise<string | null> {
  if (process.platform === "win32") return screenshotWindows();
  const file = join(tmpdir(), `pi-shelf-shot-${randomUUID()}.png`);
  const commands: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["screencapture", ["-i", "-x", file]]]
      : [["gnome-screenshot", ["-a", "-f", file]], ["spectacle", ["-b", "-n", "-o", file]], ["scrot", ["-s", file]]];
  for (const [command, args] of commands) {
    try {
      await execFileAsync(command, args, { timeout: 60_000 });
      const bytes = await readFile(file);
      if (bytes.length) return file;
    } catch {
      // try the next screenshot tool
    }
  }
  return null;
}
