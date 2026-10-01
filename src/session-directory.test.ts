import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, type Session } from "./sessions";

test("ACP directories refresh their current branch without discovering external processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-directory-"));
  const socket = join(root, "host.sock");
  const before = Bun.env.KILN_ACP_SOCKET;
  const git = join(root, ".git");
  mkdirSync(git);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/initial\n");
  const session: Session = {
    id: "owned",
    agent: "codex",
    cwd: root,
    startedAt: 1,
    activity: "idle",
    place: { kind: "acp", id: "owned" },
  };
  const server = Bun.serve({ unix: socket, fetch: () => Response.json([session]) });
  Bun.env.KILN_ACP_SOCKET = socket;
  try {
    expect((await listSessions())[0]?.branch).toBe("initial");
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/changed\n");
    expect((await listSessions())[0]?.branch).toBe("changed");
    expect(await listSessions()).toHaveLength(1);
  } finally {
    server.stop(true);
    if (before === undefined) delete Bun.env.KILN_ACP_SOCKET;
    else Bun.env.KILN_ACP_SOCKET = before;
    rmSync(root, { recursive: true, force: true });
  }
});
