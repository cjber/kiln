import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsHidden } from "./tmux";

const host = "pid:[4026531836]";

test("a process in a namespace of its own cannot see the sessions, and says so", async () => {
  expect(await sessionsHidden("pid:[4026533802]", "/nonexistent/kiln")).toContain("process namespace of its own");
});

test("a refused tmux socket is reported, and a missing or listening one is a kiln it can reach", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-tmux-"));
  const server = createServer();
  try {
    expect(await sessionsHidden(host, join(root, "missing"))).toBeUndefined();
    const socket = join(root, "open", "kiln");
    mkdirSync(join(root, "open"));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    expect(await sessionsHidden(host, socket)).toBeUndefined();
    chmodSync(join(root, "open"), 0);
    expect(await sessionsHidden(host, socket)).toBe(
      `cannot reach kiln's tmux server at ${socket}: permission denied (EACCES, sandboxed?)`,
    );
  } finally {
    chmodSync(join(root, "open"), 0o700);
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
