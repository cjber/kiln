import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountDisabled, claudeHome, defaultAccount, type Routing } from "./accounts";
import { allPages, cloudCache } from "./cloud";
import { cloudLink } from "./cloud-links";
import { type Activity, type Session, sessionIdentity } from "./sessions";

/** Claude's `worker_status` values, as its own cloud picker reads them; anything else shows as unknown. */
function activity(status: unknown): Activity | undefined {
  switch (status) {
    case "running":
      return "working";
    case "requires_action":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

/** Internal Claude Code API, verified against 2.1.316's cloud picker. Bridge rows are local sessions. */
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
    const url = cloudLink("claude", row.id);
    if (!url) throw new Error("Claude cloud returned an invalid session");
    sessions.push({
      agent: "claude",
      cwd: homedir(),
      startedAt: Date.parse(row.created_at),
      lastActiveAt: lastActivity(row.last_event_at, row.updated_at),
      activity: activity(row.worker_status),
      place: { kind: "cloud", id: row.id, title: row.title, url },
    });
  }
  return { sessions, cursor: page.next_cursor ?? null };
}

function lastActivity(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  }
  return undefined;
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

/**
 * What a Claude credentials file says of its login. `expired` is an access token past its time with a refresh token
 * Claude Code renews it from when it next runs; `needsLogin` is a login nothing but signing in again brings back.
 */
export type ClaudeLogin = { state: "ok"; token: string } | { state: "expired" | "needsLogin" | "signedOut" };

export function claudeLogin(source: string, now = Date.now()): ClaudeLogin {
  let auth: { refreshToken?: unknown; refreshTokenExpiresAt?: unknown; expiresAt?: unknown } | undefined;
  try {
    auth = JSON.parse(source)?.claudeAiOauth;
    const token = claudeCloudToken(source, now);
    return token ? { state: "ok", token } : { state: "signedOut" };
  } catch {
    // Not usable now; what is left says whether Claude Code can renew it.
  }
  const renewable =
    typeof auth?.expiresAt === "number" &&
    auth.expiresAt > 0 &&
    typeof auth.refreshToken === "string" &&
    auth.refreshToken !== "" &&
    !(typeof auth.refreshTokenExpiresAt === "number" && auth.refreshTokenExpiresAt <= now);
  return { state: renewable ? "expired" : "needsLogin" };
}

/** The cloud sessions of the login in `home`, which is kiln's own Claude config dir unless one is named. */
export async function loadClaudeCloud(home = Bun.env.CLAUDE_CONFIG_DIR || claudeHome()): Promise<Session[]> {
  if (!Bun.which("claude")) return [];
  const path = join(home, ".credentials.json");
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
  return allPages("Claude cloud", async (cursor) => {
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
    return parseClaudeCloudPage(body);
  });
}

const snapshots = new Map<string, ReturnType<typeof cloudCache>>();

/**
 * The cloud sessions of every Claude login a run can start on: kiln's own with no accounts configured, else the
 * default and each account, each row naming its account. Every login has a cache of its own, so one that fails keeps
 * its last rows and reports its own problem while the others stay live. A session two logins both list is shown once.
 */
export function claudeCloudSnapshot(
  settings: Routing = { accounts: [] },
  load: (home: string) => Promise<Session[]> = loadClaudeCloud,
) {
  const own = settings.accounts.filter((account) => account.agent === "claude");
  const logins = (
    own.length
      ? [{ name: defaultAccount, home: claudeHome() }, ...own]
      : [{ name: undefined, home: Bun.env.CLAUDE_CONFIG_DIR || claudeHome() }]
  ).filter((login) => !accountDisabled(settings, "claude", login.name));
  const sessions = new Map<string, Session>();
  const problems: string[] = [];
  for (const { name, home } of logins) {
    let snapshot = snapshots.get(home);
    if (!snapshot) {
      snapshot = cloudCache(() => load(home));
      snapshots.set(home, snapshot);
    }
    const read = snapshot();
    for (const session of read.sessions) {
      const key = sessionIdentity(session);
      if (!sessions.has(key)) sessions.set(key, name === undefined ? session : { ...session, account: name });
    }
    if (read.problem) problems.push(name === undefined ? read.problem : `${name}: ${read.problem}`);
  }
  return { sessions: [...sessions.values()], problem: problems.join(" · ") };
}
