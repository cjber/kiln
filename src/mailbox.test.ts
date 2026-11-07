import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, pending, post, posted, release, sendLimit, takeUnread } from "./mailbox";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function mailbox(): string {
  const root = mkdtempSync(join(tmpdir(), "kiln-mailbox-"));
  roots.push(root);
  return join(root, "mailbox.sqlite");
}

test("a message is delivered once, by whichever caller claims it, and never sent again once it may have arrived", () => {
  const path = mailbox();
  const message = post("claude:a", "codex:b", "hello", path, 1_000);
  expect(pending(path, 1_000).map((item) => item.id)).toEqual([message.id]);
  expect(claim(message.id, path)).toBe(true);
  expect(claim(message.id, path)).toBe(false);
  expect(pending(path, 1_000)).toEqual([]);
  release(message.id, false, path);
  expect(pending(path, 1_000)).toHaveLength(1);
  expect(claim(message.id, path)).toBe(true);
  release(message.id, true, path);
  expect(pending(path, 1_000)).toEqual([]);
  expect(takeUnread("codex:b", path).map((item) => item.body)).toEqual(["hello"]);
});

test("the inbox hands over only undelivered messages for its owner, once", () => {
  const path = mailbox();
  const read = post("claude:a", "codex:b", "read me", path, 1_000);
  const delivered = post("claude:a", "codex:b", "already typed", path, 2_000);
  post("claude:a", "pi:c", "not yours", path, 3_000);
  claim(delivered.id, path);
  expect(takeUnread("codex:b", path, 4_000)).toEqual([{ ...read, readAt: 4_000 }]);
  expect(takeUnread("codex:b", path)).toEqual([]);
  expect(pending(path, 4_000).map((item) => item.to)).toEqual(["pi:c"]);
});

test("old messages expire, a reader never creates the file, and a sender is stopped before a loop runs away", () => {
  const path = mailbox();
  expect(pending(path)).toEqual([]);
  expect(takeUnread("codex:b", path)).toEqual([]);
  expect(existsSync(path)).toBe(false);
  post("claude:a", "codex:b", "old", path, 0);
  expect(pending(path, 8 * 24 * 60 * 60 * 1000)).toEqual([]);
  for (let index = 0; index < sendLimit.count; index++) post("claude:a", "codex:b", `${index}`, path, 1_000);
  expect(() => post("claude:a", "codex:b", "one more", path, 1_000)).toThrow("wait before sending more");
  expect(post("claude:a", "pi:c", "someone else", path, 1_000).to).toBe("pi:c");
  expect(post("claude:a", "codex:b", "later", path, 1_000 + sendLimit.perMs).body).toBe("later");
});

test("concurrent processes reading their inboxes while others send never see a locked database", async () => {
  const path = mailbox();
  post("claude:a", "codex:b", "create the file", path);
  const worker = join(import.meta.dir, "..", "scripts", "mailbox-stress.test-worker.ts");
  const workers = Array.from({ length: 6 }, (_, index) =>
    Bun.spawn(["bun", worker, path, String(index)], { stdout: "pipe", stderr: "pipe" }),
  );
  const results = await Promise.all(
    workers.map(async (child) => ({ code: await child.exited, error: await new Response(child.stderr).text() })),
  );
  expect(results.filter((result) => result.code !== 0).map((result) => result.error)).toEqual([]);
}, 30_000);

test("a message is found by its id after it is delivered", () => {
  const path = mailbox();
  expect(posted("ask:1", path)).toBeUndefined();
  post("opencode:ses_1", "claude:p1", "Which branch?", path, 1, "ask:1");
  claim("ask:1", path);
  expect(posted("ask:1", path)).toMatchObject({ from: "opencode:ses_1", to: "claude:p1" });
});
