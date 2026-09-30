import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "./sessions";

test("Claude follows a live cwd change and rereads the branch without restarting", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-directory-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const tools = join(root, "bin");
  for (const dir of [first, second, tools]) mkdirSync(dir);
  for (const [dir, branch] of [
    [first, "initial"],
    [second, "moved"],
  ]) {
    expect(Bun.spawnSync(["git", "init", "-b", branch, dir], { stderr: "ignore" }).exitCode).toBe(0);
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `process.chdir(${JSON.stringify(first)}); console.log('ready'); for await (const line of console) { process.chdir(line); console.log('ready'); }`,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const output = child.stdout.getReader();
  const discover = async (): Promise<Session[]> => {
    const discovery = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { listSessions } from ${JSON.stringify(new URL("./sessions.ts", import.meta.url).href)}; console.log(JSON.stringify(await listSessions({ kitty: false })));`,
      ],
      {
        env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, CODEX_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const result = await new Response(discovery.stdout).text();
    expect(await new Response(discovery.stderr).text()).toBe("");
    expect(await discovery.exited).toBe(0);
    return JSON.parse(result);
  };
  try {
    await output.read();
    for (const [name, body] of [
      ["claude", `printf '%s\n' '${JSON.stringify([{ pid: child.pid, cwd: first, status: "idle" }])}'`],
      ["pgrep", "exit 1"],
      ["tmux", "exit 1"],
    ]) {
      const path = join(tools, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o700);
    }
    const initial = (await discover()).find((session) => session.pid === child.pid);
    expect(initial?.cwd).toBe(first);
    expect(initial?.branch).toBe("initial");
    child.stdin.write(`${second}\n`);
    await output.read();
    const moved = (await discover()).find((session) => session.pid === child.pid);
    expect(moved?.cwd).toBe(second);
    expect(moved?.branch).toBe("moved");
    expect(Bun.spawnSync(["git", "-C", second, "symbolic-ref", "HEAD", "refs/heads/changed"]).exitCode).toBe(0);
    const changed = (await discover()).find((session) => session.pid === child.pid);
    expect(changed?.branch).toBe("changed");
  } finally {
    child.kill();
    await child.exited;
    output.releaseLock();
    rmSync(root, { recursive: true, force: true });
  }
});
