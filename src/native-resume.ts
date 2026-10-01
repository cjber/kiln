import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SavedSession } from "./acp";
import { acpRequest } from "./acp-host";
import type { Session } from "./sessions";

function statePath() {
  return Bun.env.KILN_ACP_SOCKET
    ? `${Bun.env.KILN_ACP_SOCKET}.json`
    : join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "acp.json");
}
function archivePath() {
  return `${statePath()}.native`;
}
function records(path: string): SavedSession[] {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}
function nativeSession(record: SavedSession, owned: boolean): Session {
  const session = record.conversation.session;
  if (session.agent === "pi" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.providerId))
    throw new Error("Saved session has no native provider identity");
  return {
    ...session,
    id: record.providerId,
    pid: undefined,
    activity: owned ? session.activity : undefined,
    place: {
      kind: "background",
      id: record.providerId,
      attach:
        session.agent === "claude" ? ["claude", "--resume", record.providerId] : ["codex", "resume", record.providerId],
      acpId: owned ? session.id : undefined,
    },
  };
}

/** Provider IDs differ from kiln's ACP IDs. Keep a private recovery copy when handing it to the native TUI. */
export function nativeSavedSessions(owned: Session[]): Session[] {
  const saved = records(statePath());
  const archive = archivePath();
  const migrated = existsSync(archive)
    ? readdirSync(archive)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => records(join(archive, name)))
    : [];
  const rows = owned.map((session) => {
    if (session.agent === "pi") return session;
    const record = saved.find((record) => record.conversation.session.id === session.id);
    if (!record) return session;
    try {
      return nativeSession(record, true);
    } catch {
      return session;
    }
  });
  const ownedIds = new Set(owned.map((session) => session.id));
  for (const record of migrated) {
    if (ownedIds.has(record.conversation.session.id)) continue;
    rows.push(nativeSession(record, false));
  }
  return rows;
}

/** Archive kiln's chat history before releasing its adapter; the provider owns native conversation history. */
export async function releaseForNative(session: Session): Promise<void> {
  if (session.place.kind !== "background" || !session.place.acpId) return;
  const id = session.place.acpId;
  const record = records(statePath()).find((record) => record.conversation.session.id === id);
  if (!record || nativeSession(record, true).id !== session.id)
    throw new Error("Saved provider identity changed; refresh the session list");
  const directory = archivePath();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${encodeURIComponent(id)}.json`);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, JSON.stringify([record]), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
  await acpRequest(`/sessions/${id}/close`, {});
}
