import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPeer, peekUnread, peerName } from "./mailbox";
import { runMsgCli } from "./msg-cli";
import * as sessions from "./sessions";
import * as tmux from "./tmux";

describe("peer identities", () => {
  test("a peer is an @name that cannot be read as a session", () => {
    expect(peerName("@nebula")).toBe("@nebula");
    expect(peerName("@nebula-ai:thread_1")).toBe("@nebula-ai:thread_1");
    expect(isPeer("@nebula")).toBe(true);
    expect(isPeer("opencode:ses_1")).toBe(false);
  });

  test("a name without the leading @ is refused, so an override cannot impersonate a session", () => {
    for (const raw of ["nebula", "@", "@a b", "@nebula\n"]) expect(() => peerName(raw)).toThrow();
  });
});

test("JSON inbox and peer sends work without session discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-msg-cli-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/msg-cli-smoke.ts")], {
      env: { ...Bun.env, XDG_STATE_HOME: root, CLAUDE_CONFIG_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    expect(await new Response(child.stderr).text()).toBe("");
    expect(code).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(output).toContain('"body": "reply"');
    expect(output).toContain('"to": "@receiver"');
    expect(output.match(/"body": "late"/g)).toHaveLength(2);
    expect(output).toContain("\n1\n");
    const view = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/msg-cli-smoke.ts")], {
      env: { ...Bun.env, XDG_STATE_HOME: root, CLAUDE_CONFIG_DIR: root, VIEW_ONLY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await view.exited).toBe(0);
    expect(await new Response(view.stderr).text()).toBe("");
    const viewOutput = await new Response(view.stdout).text();
    expect(viewOutput).toContain("you: fixture prompt");
    expect(viewOutput).toContain("fixture answer");
    expect(viewOutput).toContain("Read notes.md");
    expect(viewOutput).toContain('"text": "ended answer"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sandboxed child addresses its parent by full name without seeing the sessions (#264)", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-msg-outbox-"));
  const outbox = Bun.env.KILN_OUTBOX;
  Bun.env.KILN_OUTBOX = root;
  const hidden = spyOn(tmux, "sessionsHidden").mockResolvedValue("kiln runs in a process namespace of its own");
  const discovery = spyOn(sessions, "discovery").mockImplementation(() => {
    throw new Error("a hidden caller must not discover sessions");
  });
  const printed = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMsgCli(["send", "claude:parent-1", "done"]);
    const files = readdirSync(root).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, files[0] ?? ""), "utf8"))).toEqual({
      to: "claude:parent-1",
      body: "done",
    });
    expect(printed.mock.calls[0]?.[0]).toContain("claude:parent-1: queued");
    // A peer parent is a mailbox the sandbox cannot write either, so it goes through the outbox too (#333).
    await runMsgCli(["send", "@nebula", "peer done"]);
    const peerFiles = readdirSync(root).filter((file) => file.endsWith(".json") && !files.includes(file));
    expect(peerFiles.map((file) => JSON.parse(readFileSync(join(root, file), "utf8")))).toEqual([
      { to: "@nebula", body: "peer done" },
    ]);
    // Every other session is found only by discovery, so a broadcast still says why it cannot.
    await expect(runMsgCli(["send", "--all", "done"])).rejects.toThrow("name the recipient");
    // Without an outbox the message goes straight to the mailbox, where only a full name reaches anyone.
    delete Bun.env.KILN_OUTBOX;
    const state = Bun.env.XDG_STATE_HOME;
    Bun.env.XDG_STATE_HOME = root;
    try {
      await expect(runMsgCli(["send", "parent", "done"])).rejects.toThrow("name the recipient in full");
      await runMsgCli(["send", "claude:parent-1", "again"]);
      expect(peekUnread("claude:parent-1").map(({ body }) => body)).toEqual(["again"]);
    } finally {
      if (state === undefined) delete Bun.env.XDG_STATE_HOME;
      else Bun.env.XDG_STATE_HOME = state;
    }
  } finally {
    hidden.mockRestore();
    discovery.mockRestore();
    printed.mockRestore();
    if (outbox === undefined) delete Bun.env.KILN_OUTBOX;
    else Bun.env.KILN_OUTBOX = outbox;
    rmSync(root, { recursive: true, force: true });
  }
});
