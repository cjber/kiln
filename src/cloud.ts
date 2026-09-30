import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { Activity, Session } from "./sessions";

const statuses = ["pending", "ready", "applied", "error"] as const;
type CloudStatus = (typeof statuses)[number];

function activity(status: CloudStatus | undefined): Activity | undefined {
  switch (status) {
    case "pending":
      return "working";
    case "ready":
    case "error":
      return "waiting";
    case "applied":
      return "idle";
    case undefined:
      return undefined;
  }
}

/** Matches codex cloud list --json; its timestamp is the last update, not creation. */
export function parseCloudPage(source: string): { sessions: Session[]; cursor: string | null } {
  const page = JSON.parse(source);
  if (!page || !Array.isArray(page.tasks) || !(page.cursor === null || typeof page.cursor === "string"))
    throw new Error("codex cloud returned an invalid task page");
  const sessions = page.tasks.map((task: Record<string, unknown>): Session => {
    if (
      !task ||
      typeof task.id !== "string" ||
      !task.id ||
      typeof task.title !== "string" ||
      typeof task.status !== "string" ||
      typeof task.updated_at !== "string" ||
      !Number.isFinite(Date.parse(task.updated_at))
    )
      throw new Error("codex cloud returned an invalid task");
    const status = statuses.includes(task.status as CloudStatus) ? (task.status as CloudStatus) : undefined;
    return {
      agent: "codex",
      cwd: homedir(),
      startedAt: Date.parse(task.updated_at),
      activity: activity(status),
      place: { kind: "cloud", id: task.id, title: task.title },
    };
  });
  return { sessions, cursor: page.cursor };
}

async function loadCloud(): Promise<Session[]> {
  if (!Bun.which("codex")) return [];
  const directory = mkdtempSync(join(tmpdir(), "kiln-cloud-"));
  let process: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    process?.kill();
  }, 10_000);
  try {
    const sessions: Session[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      if (expired) throw new Error("codex cloud list timed out");
      process = Bun.spawn(["codex", "cloud", "list", "--json", ...(cursor ? ["--cursor", cursor] : [])], {
        cwd: directory,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (expired) throw new Error("codex cloud list timed out");
      if (code !== 0) throw new Error(`codex cloud list failed: ${stderr.trim() || `exit ${code}`}`);
      const page = parseCloudPage(stdout);
      sessions.push(...page.sessions);
      cursor = page.cursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("codex cloud repeated a pagination cursor");
        cursors.add(cursor);
      }
    } while (cursor);
    return sessions;
  } finally {
    clearTimeout(timeout);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A refresh returns immediately with the last snapshot, even while the CLI is slow or unavailable. */
export function cloudCache(load = loadCloud, now = Date.now) {
  let sessions: Session[] = [];
  let problem = "";
  let nextRefresh = 0;
  let pending = false;
  return (refresh = true) => {
    if (refresh && !pending && now() >= nextRefresh) {
      pending = true;
      nextRefresh = now() + 60_000;
      void Promise.resolve()
        .then(load)
        .then((loaded) => {
          sessions = loaded;
          problem = "";
        })
        .catch((error: unknown) => {
          problem = `${error instanceof Error ? error.message : String(error)}; cloud rows may be stale`;
        })
        .finally(() => {
          pending = false;
        });
    }
    return { sessions, problem };
  };
}

export const cloudSnapshot = cloudCache();
