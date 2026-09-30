import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import extension from "../extensions/pi-remote.js" with { type: "text" };

export function installPiExtension(home?: string, updateOnly = false): string | undefined {
  const path = join(
    home ? join(home, ".pi", "agent") : Bun.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "extensions",
    "kiln-remote.js",
  );
  let info: ReturnType<typeof lstatSync> | undefined;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!info && updateOnly) return undefined;
  if (info) {
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    const old = readFileSync(path, "utf8");
    if (old === extension) return path;
    if (!old.startsWith("// kiln-managed Pi remote extension\n")) throw new Error(`${path} is not managed by kiln`);
    writeFileSync(`${path}.${randomUUID()}.bak`, old, { flag: "wx", mode: 0o600 });
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.kiln-${randomUUID()}.js`);
  writeFileSync(temporary, extension, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return path;
}
