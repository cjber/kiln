import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SavedSession } from "./acp";
import { acpRequest, acpStatePath } from "./acp-host";
import type { Session } from "./sessions";

function archivePath() {
  return `${acpStatePath()}.native`;
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
      kind: "saved",
      id: record.providerId,
      attach:
        session.agent === "claude" ? ["claude", "--resume", record.providerId] : ["codex", "resume", record.providerId],
      acpId: owned ? session.id : undefined,
    },
  };
}

/** Recovery files are private backups; one unreadable file must not hide every other session. */
function archivedRecords(): { path: string; records: SavedSession[] }[] {
  const directory = archivePath();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const path = join(directory, name);
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? [{ path, records: parsed as SavedSession[] }] : [];
      } catch {
        return [];
      }
    });
}

/** Provider IDs differ from kiln's ACP IDs. Keep a private recovery copy when handing it to the native TUI. */
export function nativeSavedSessions(owned: Session[]): Session[] {
  const saved = records(acpStatePath());
  const migrated = archivedRecords().flatMap(({ records }) => records);
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
    try {
      rows.push(nativeSession(record, false));
    } catch {
      // A recovery record without a provider identity has nothing to resume.
    }
  }
  return rows;
}

/** Archive kiln's chat history before releasing its adapter; the provider owns native conversation history. */
export async function releaseForNative(session: Session): Promise<void> {
  if (session.place.kind !== "saved" || !session.place.acpId) return;
  const id = session.place.acpId;
  const record = records(acpStatePath()).find((record) => record.conversation.session.id === id);
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

/** Explicit close retires recovery rows while keeping the private history backup. */
export function closeNativeRecovery(session: Session): void {
  for (const { path, records } of archivedRecords()) {
    if (
      records.some((record) => record.providerId === session.id && record.conversation.session.agent === session.agent)
    )
      renameSync(path, `${path}.closed`);
  }
}
