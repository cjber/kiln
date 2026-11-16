import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPeer, peerName } from "./msg-cli";

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
      env: { ...Bun.env, XDG_STATE_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    expect(await new Response(child.stderr).text()).toBe("");
    expect(code).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(output).toContain('"body": "reply"');
    expect(output).toContain('"to": "@receiver"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
