import { closeSync, openSync, readSync, statSync } from "node:fs";

const cache = new Map<
  string,
  {
    inode: number;
    offset: number;
    modified: number;
    pending: string;
    decoder: TextDecoder;
    title?: string;
    generated?: string;
  }
>();

/**
 * Read only title records, retaining the last complete line while a transcript is being appended.
 * A title the user set wins over the one Claude generates.
 */
export function transcriptTitle(path: string): string | undefined {
  try {
    const info = statSync(path);
    const key = path;
    let saved = cache.get(key);
    if (
      !saved ||
      saved.inode !== info.ino ||
      info.size < saved.offset ||
      (info.size === saved.offset && info.mtimeMs !== saved.modified)
    ) {
      saved = { inode: info.ino, offset: 0, modified: 0, pending: "", decoder: new TextDecoder() };
      cache.set(key, saved);
    }
    if (saved.modified === info.mtimeMs && saved.offset === info.size) return saved.title ?? saved.generated;
    const fd = openSync(path, "r");
    try {
      const bytes = Buffer.alloc(64 * 1024);
      while (saved.offset < info.size) {
        const count = readSync(fd, bytes, 0, Math.min(bytes.length, info.size - saved.offset), saved.offset);
        if (!count) break;
        saved.offset += count;
        const lines = (saved.pending + saved.decoder.decode(bytes.subarray(0, count), { stream: true })).split("\n");
        saved.pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.includes('-title"')) continue;
          try {
            const record = JSON.parse(line);
            if (record.type === "custom-title" && typeof record.customTitle === "string")
              saved.title = record.customTitle.trim() || undefined;
            else if (record.type === "ai-title" && typeof record.aiTitle === "string")
              saved.generated = record.aiTitle.trim() || undefined;
          } catch {
            // Ignore incomplete or unrelated records; a title never establishes activity.
          }
        }
        if (saved.pending.length > 64 * 1024) saved.pending = "";
      }
      saved.modified = info.mtimeMs;
    } finally {
      closeSync(fd);
    }
    if (cache.size > 128) cache.delete(cache.keys().next().value ?? "");
    return saved.title ?? saved.generated;
  } catch (error) {
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}
