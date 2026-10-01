import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piBridges, piStates } from "./pi";

test("Pi discovery skips the runtime directory when no Pi processes exist", async () => {
  const saved = Bun.env.XDG_RUNTIME_DIR;
  try {
    Bun.env.XDG_RUNTIME_DIR = `/nonexistent-kiln-runtime-${process.pid}`;
    expect(await piStates([])).toEqual(new Map());
  } finally {
    if (saved === undefined) delete Bun.env.XDG_RUNTIME_DIR;
    else Bun.env.XDG_RUNTIME_DIR = saved;
  }
});

test("asynchronous Pi discovery retains private live-process bridge verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-pi-discovery-"));
  const saved = Bun.env.XDG_RUNTIME_DIR;
  const directory = join(root, "kiln-pi-fixture");
  mkdirSync(directory, { mode: 0o700 });
  const socket = join(directory, "control.sock");
  const descriptor = join(directory, "session.json");
  const server = createServer((client) => {
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const command = JSON.parse(buffer);
      client.write(
        `${JSON.stringify({
          type: "response",
          id: command.id,
          success: true,
          data: { sessionId: "fixture", cwd: root, activity: "idle" },
        })}\n`,
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    chmodSync(socket, 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify({
        pid: process.pid,
        startedAt: Math.trunc(lstatSync(`/proc/${process.pid}`).mtimeMs),
        socket,
      }),
      { mode: 0o600 },
    );
    Bun.env.XDG_RUNTIME_DIR = root;
    expect(piBridges(root)).toHaveLength(1);
    expect((await piStates([process.pid])).get(process.pid)).toMatchObject({ sessionId: "fixture", activity: "idle" });
    chmodSync(descriptor, 0o644);
    expect(piBridges(root)).toEqual([]);
    expect(await piStates([process.pid])).toEqual(new Map());
  } finally {
    if (saved === undefined) delete Bun.env.XDG_RUNTIME_DIR;
    else Bun.env.XDG_RUNTIME_DIR = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
