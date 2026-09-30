import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import extension from "../extensions/pi-remote.js" with { type: "text" };

export function installPiExtension(home = homedir(), updateOnly = false): string | undefined {
  const path = join(Bun.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "extensions", "kiln-remote.js");
  if (!existsSync(path) && updateOnly) return undefined;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
    const old = readFileSync(path, "utf8");
    if (old === extension) return path;
    if (!old.startsWith("// kiln-managed Pi remote extension\n")) throw new Error(`${path} is not managed by kiln`);
    writeFileSync(`${path}.${Date.now()}.bak`, old, { flag: "wx", mode: 0o600 });
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.kiln-${randomUUID()}.js`);
  writeFileSync(temporary, extension, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return path;
}
