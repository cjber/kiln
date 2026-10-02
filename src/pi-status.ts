import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../pi-extension/kiln-status.js" with { type: "text" };
import type { Activity } from "./sessions";

/** Where the extension in each kiln-started Pi writes its status; the extension computes the same path. */
function statusDirectory(): string {
  return Bun.env.KILN_PI_STATUS_DIR || join(Bun.env.XDG_RUNTIME_DIR || tmpdir(), "kiln-pi");
}

/** Pi reads an extension from a real file, including when kiln is a standalone executable. */
export function piExtensionPath(): string {
  const directory = join(Bun.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiln");
  const path = join(directory, "pi-status.js");
  if (!existsSync(path) || readFileSync(path, "utf8") !== extension) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, extension);
  }
  return path;
}

/** The extension's own states; anything else shows as unknown rather than guessed. */
function piActivity(status: unknown): Activity | undefined {
  switch (status) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

export type PiStatus = { id?: string; title?: string; activity?: Activity; lastActiveAt?: number };

/** A Pi started without kiln's extension has no record; a record for another process with this pid is ignored. */
export function piStatus(pid: number, startedAt: number): PiStatus {
  try {
    const record = JSON.parse(readFileSync(join(statusDirectory(), `${pid}.json`), "utf8"));
    if (record.pid !== pid || record.startedAt !== Math.trunc(startedAt)) return {};
    return {
      id: typeof record.sessionId === "string" ? record.sessionId : undefined,
      title: typeof record.title === "string" ? record.title : undefined,
      activity: piActivity(record.activity),
      lastActiveAt: typeof record.updatedAt === "number" ? record.updatedAt : undefined,
    };
  } catch {
    return {};
  }
}
