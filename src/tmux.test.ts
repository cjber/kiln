import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsHidden, tmuxSocket } from "./tmux";
import { killServer } from "./tmux-server";

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

test("a session started from inside another tmux pane keeps its own exit options, not the caller's", () => {
  // An agent in kiln's tmux spawning a child runs with $TMUX_PANE set to its own pane, which tmux would otherwise
  // take as the target of every command after new-session, so the child lost its exit hook and its exit status.
  const server = `kiln-start-${process.pid}`;
  const show = (...args: string[]) =>
    Bun.spawnSync(["tmux", "-L", server, ...args], { stdout: "pipe", stderr: "pipe" })
      .stdout.toString()
      .trim();
  const startFrom = (pane: string, ...args: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { start } from ${JSON.stringify(join(import.meta.dir, "tmux"))};
        const [name, keep, hook] = process.argv.slice(-3);
        process.exit(start(name, "/", ["sleep", "60"], name, keep === "keep", hook || undefined) ? 0 : 1);`,
        ...args,
      ],
      {
        env: {
          ...Bun.env,
          KILN_TMUX_SERVER: server,
          TMUX: `${tmuxSocket(server)},1,0`,
          TMUX_PANE: pane,
        },
      },
    ).exitCode;
  try {
    expect(startFrom("", "caller", "", "")).toBe(0);
    const caller = show("display-message", "-p", "-t", "=caller:", "#{pane_id}");
    expect(startFrom(caller, "child", "", 'run-shell -b "true"')).toBe(0);
    expect(startFrom(caller, "kept", "keep", "")).toBe(0);
    expect(show("show-hooks", "-w", "-t", "=child:", "pane-died")).toBe("pane-died[0] run-shell -b true");
    for (const name of ["child", "kept"])
      expect(show("show-options", "-w", "-t", `=${name}:`, "remain-on-exit")).toBe("remain-on-exit on");
    expect(show("show-hooks", "-w", "-t", "=caller:", "pane-died")).toBe("");
    expect(show("show-options", "-w", "-t", "=caller:", "remain-on-exit")).toBe("");
  } finally {
    killServer(server);
  }
});
