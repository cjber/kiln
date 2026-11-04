import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The largest file a phone can attach. */
export const uploadLimit = 20 * 1024 * 1024;
/** All uploads together stay under this, so a phone cannot fill the disk before the week is up. */
export const uploadQuota = 500 * 1024 * 1024;
const keep = 7 * 24 * 60 * 60 * 1000;

export class UploadsFull extends Error {}

export const uploadsDirectory = () => join(Bun.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "kiln", "uploads");

/** A name that is safe as one path segment and still tells the agent what the file is. */
export function uploadName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const safe = base
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-80);
  return safe || "file";
}

/**
 * Store a file a phone attached where any agent on this computer can read it, and return its path. Each upload
 * gets its own directory, so two files with one name never collide, and week-old uploads are cleared.
 */
export async function saveUpload(
  name: string,
  bytes: ArrayBuffer,
  now = Date.now(),
  quota = uploadQuota,
): Promise<string> {
  const root = uploadsDirectory();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let used = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    try {
      if (now - statSync(path).mtimeMs > keep) rmSync(path, { recursive: true, force: true });
      else for (const file of readdirSync(path)) used += statSync(join(path, file)).size;
    } catch {
      // Removed by another upload meanwhile.
    }
  }
  if (used + bytes.byteLength > quota) throw new UploadsFull("Uploads are full; files clear a week after they arrive");
  const directory = join(root, `${new Date(now).toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, uploadName(name));
  await Bun.write(path, bytes);
  return path;
}
