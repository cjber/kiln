import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudCache } from "./cloud";
import type { Activity, Session } from "./sessions";

const statuses = ["idle", "working", "waiting", "completed", "archived", "cancelled", "rejected"] as const;
type CloudStatus = (typeof statuses)[number];

function activity(status: CloudStatus | undefined): Activity | undefined {
  switch (status) {
    case "working":
      return "working";
    case "waiting":
    case "rejected":
      return "waiting";
    case "idle":
    case "completed":
    case "archived":
    case "cancelled":
      return "idle";
    case undefined:
      return undefined;
  }
}

/** Internal Claude Code API, verified against 2.1.285's cloud picker. Bridge rows are local sessions. */
export function parseClaudeCloudPage(source: string): { sessions: Session[]; cursor: string | null } {
  let page: { data?: unknown; next_cursor?: unknown } | null;
  try {
    page = JSON.parse(source);
  } catch {
    throw new Error("Claude cloud returned an invalid session page");
  }
  if (
    !page ||
    !Array.isArray(page.data) ||
    !(page.next_cursor === undefined || page.next_cursor === null || typeof page.next_cursor === "string")
  )
    throw new Error("Claude cloud returned an invalid session page");
  const sessions: Session[] = [];
  for (const row of page.data) {
    if (!row || typeof row !== "object" || typeof row.environment_kind !== "string" || typeof row.status !== "string")
      throw new Error("Claude cloud returned an invalid session");
    if (row.environment_kind !== "anthropic_cloud" || row.status === "archived") continue;
    if (
      typeof row.id !== "string" ||
      !/^(?:session|cse)_[A-Za-z0-9_-]+$/.test(row.id) ||
      typeof row.title !== "string" ||
      typeof row.worker_status !== "string" ||
      typeof row.created_at !== "string" ||
      !Number.isFinite(Date.parse(row.created_at))
    )
      throw new Error("Claude cloud returned an invalid session");
    if (
      !row.title.trim() ||
      row.title.includes("__CBU_POOLED__") ||
      row.title === "__warming__" ||
      row.title.startsWith("ditto:")
    )
      continue;
    const status = statuses.includes(row.worker_status as CloudStatus) ? (row.worker_status as CloudStatus) : undefined;
    sessions.push({
      agent: "claude",
      cwd: homedir(),
      startedAt: Date.parse(row.created_at),
      activity: activity(status),
      place: { kind: "cloud", id: row.id, title: row.title },
    });
  }
  return { sessions, cursor: page.next_cursor ?? null };
}

/** Never include credentials or response bodies in a diagnostic shown in the TUI. */
export function claudeCloudToken(source: string, now = Date.now()): string | undefined {
  let credentials: { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null;
  try {
    credentials = JSON.parse(source);
  } catch {
    throw new Error("Claude credentials file is invalid; sign in with claude auth login");
  }
  const auth = credentials?.claudeAiOauth;
  if (auth === undefined) return undefined;
  if (
    typeof auth?.accessToken !== "string" ||
    !auth.accessToken ||
    typeof auth.expiresAt !== "number" ||
    !Number.isFinite(auth.expiresAt)
  )
    throw new Error("Claude credentials are invalid; sign in with claude auth login");
  if (auth.expiresAt <= now)
    throw new Error("Claude credentials expired; open Claude to refresh them or run claude auth login");
  return auth.accessToken;
}

export async function loadClaudeCloud(): Promise<Session[]> {
  if (!Bun.which("claude")) return [];
  const path = join(Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("could not read Claude credentials");
  }
  const token = claudeCloudToken(source);
  if (!token) return [];
  const signal = AbortSignal.timeout(10_000);
  const cursors = new Set<string>();
  const sessions = new Map<string, Session>();
  let cursor: string | null = null;
  do {
    const url = new URL("https://api.anthropic.com/v1/code/sessions");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    let response: Response;
    try {
      response = await fetch(url, {
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-client-platform": "linux",
          "Content-Type": "application/json",
        },
      });
    } catch {
      throw new Error(signal.aborted ? "Claude cloud listing timed out" : "could not reach Claude cloud");
    }
    if (!response.ok) throw new Error(`Claude cloud listing failed (HTTP ${response.status})`);
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new Error("could not read Claude cloud response");
    }
    const page = parseClaudeCloudPage(body);
    for (const session of page.sessions) {
      if (session.place.kind === "cloud") sessions.set(session.place.id, session);
    }
    cursor = page.cursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Claude cloud repeated a pagination cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return [...sessions.values()];
}

export const claudeCloudSnapshot = cloudCache(loadClaudeCloud);
