import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, pending, post, release, sendLimit, takeUnread } from "./mailbox";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function mailbox(): string {
  const root = mkdtempSync(join(tmpdir(), "kiln-mailbox-"));
  roots.push(root);
  return join(root, "mailbox.sqlite");
}

test("a message is delivered once, by whichever caller claims it, and goes back if delivery fails", () => {
  const path = mailbox();
  const message = post("claude:a", "codex:b", "hello", path, 1_000);
  expect(pending(path, 1_000).map((item) => item.id)).toEqual([message.id]);
  expect(claim(message.id, path)).toBe(true);
  expect(claim(message.id, path)).toBe(false);
  expect(pending(path, 1_000)).toEqual([]);
  release(message.id, path);
  expect(pending(path, 1_000)).toHaveLength(1);
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
