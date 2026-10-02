import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SavedSession } from "./acp";
import { sessionAction } from "./launcher";
import { closeNativeRecovery, nativeSavedSessions, releaseForNative } from "./native-resume";
import type { Session } from "./sessions";

test("saved ACP sessions open the exact native provider identity and retain recovery history", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-native-resume-"));
  const socket = join(root, "host.sock");
  const before = Bun.env.KILN_ACP_SOCKET;
  Bun.env.KILN_ACP_SOCKET = socket;
  const session: Session = {
    id: "kiln-id",
    agent: "codex",
    cwd: root,
    startedAt: 1,
    activity: "working",
    place: { kind: "acp", id: "kiln-id" },
  };
  const record: SavedSession = {
    conversation: { session, messages: [{ id: "message", role: "user", text: "Keep this history" }], approvals: [] },
    providerId: "00000000-0000-0000-0000-000000000001",
    command: ["codex-acp"],
  };
  writeFileSync(`${socket}.json`, JSON.stringify([record]));
  let closed = false;
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/sessions/kiln-id/close");
      expect(request.method).toBe("POST");
      expect(existsSync(`${socket}.json.native`)).toBe(true);
      closed = true;
      return Response.json({ ok: true });
    },
  });
  try {
    const native = nativeSavedSessions([session])[0];
    if (!native) throw new Error("Missing native session");
    expect(native.place).toEqual({
      kind: "saved",
      id: record.providerId,
      attach: ["codex", "resume", record.providerId],
      acpId: "kiln-id",
    });
    expect(native.activity).toBe("working");
    await releaseForNative(native);
    expect(closed).toBe(true);
    expect(JSON.parse(readFileSync(join(`${socket}.json.native`, "kiln-id.json"), "utf8"))).toEqual([record]);
    expect(nativeSavedSessions([])[0]?.activity).toBeUndefined();
    const recovery = nativeSavedSessions([])[0];
    expect(recovery?.place).toMatchObject({
      attach: ["codex", "resume", record.providerId],
      acpId: undefined,
    });
    if (!recovery) throw new Error("Missing recovery row");
    expect(sessionAction({ ...recovery, agent: "claude" })).toEqual({ verb: "close" });
    writeFileSync(join(`${socket}.json.native`, "corrupt.json"), "{garbage");
    writeFileSync(join(`${socket}.json.native`, "no-identity.json"), JSON.stringify([{ ...record, providerId: "x" }]));
    expect(nativeSavedSessions([])).toHaveLength(1);
    closeNativeRecovery(native);
    expect(nativeSavedSessions([])).toEqual([]);
    expect(JSON.parse(readFileSync(join(`${socket}.json.native`, "kiln-id.json.closed"), "utf8"))).toEqual([record]);
    record.providerId = "--last";
    writeFileSync(`${socket}.json`, JSON.stringify([record]));
    expect(nativeSavedSessions([session])[0]?.place.kind).toBe("acp");
    await expect(releaseForNative(native)).rejects.toThrow("native provider identity");
    const pi = { ...session, agent: "pi" as const };
    expect(nativeSavedSessions([pi])[0]?.place.kind).toBe("acp");
  } finally {
    server.stop(true);
    if (before === undefined) delete Bun.env.KILN_ACP_SOCKET;
    else Bun.env.KILN_ACP_SOCKET = before;
    rmSync(root, { recursive: true, force: true });
  }
});
