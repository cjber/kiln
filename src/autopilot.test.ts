import { expect, test } from "bun:test";
import { autopilot, pullEvents } from "./autopilot";
import type { PullRequest } from "./dashboard";
import type { Session } from "./sessions";

const pr = (extra: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  draft: false,
  additions: 1,
  deletions: 1,
  queued: false,
  checks: { passed: 1, failed: 0, running: 0 },
  repository: "r",
  head: "abcdef123",
  mergeable: "MERGEABLE",
  failedChecks: [],
  reviews: 0,
  ...extra,
});
const session = (id: string, lastActiveAt: number): Session => ({
  id,
  agent: "claude",
  cwd: "/w",
  startedAt: 1,
  lastActiveAt,
  place: { kind: "kiln", name: id },
});

test("a failing or conflicting pull request is told once per head commit", () => {
  const failing = pr({
    checks: { passed: 0, failed: 1, running: 1 },
    failedChecks: ["lint"],
    mergeable: "CONFLICTING",
  });
  expect(pullEvents(failing, undefined).map((event) => event.key)).toEqual([
    "https://github.com/o/r/pull/7:abcdef123:failed",
    "https://github.com/o/r/pull/7:abcdef123:conflict",
  ]);
  expect(pullEvents(failing, undefined)[0]?.body).toContain("failing checks on abcdef1: lint");
  expect(pullEvents(pr({ head: undefined, mergeable: "CONFLICTING" }), undefined)).toEqual([]);
});

test("reviews and merges are told only when a refresh sees them happen", () => {
  const reviewed = pr({ reviews: 2, review: { author: "coderabbitai", state: "CHANGES_REQUESTED" } });
  expect(pullEvents(reviewed, undefined)).toEqual([]);
  expect(pullEvents(reviewed, { state: "OPEN", reviews: 1 })[0]?.body).toContain(
    "new review from coderabbitai (changes requested). Read it",
  );
  expect(pullEvents(pr({ state: "MERGED" }), undefined)).toEqual([]);
  expect(pullEvents(pr({ state: "MERGED" }), { state: "OPEN", reviews: 0 })[0]?.key).toBe(
    "https://github.com/o/r/pull/7:merged",
  );
});

test("a pull request goes to the session that opened it, else the most recently active one on its branch", () => {
  const sent: [string, string, string | undefined][] = [];
  const tell = autopilot((from, to, body, _path, _now, id) => {
    sent.push([to, body, id]);
    return { id: id ?? "", from, to, body, createdAt: 0 };
  });
  const failing = pr({ checks: { passed: 0, failed: 1, running: 0 }, failedChecks: ["ci"] });
  const older = session("older", 1);
  const newer = session("newer", 5);
  const opener = session("opener", 0);
  expect(
    tell(
      new Map([
        [older, [failing]],
        [newer, [failing]],
      ]),
    ),
  ).toBe(1);
  expect(sent[0]?.[0]).toBe("claude:newer");
  expect(sent[0]?.[2]).toBe("autopilot:https://github.com/o/r/pull/7:abcdef123:failed");
  tell(
    new Map([
      [newer, [failing]],
      [opener, [{ ...failing, opened: true }]],
    ]),
  );
  expect(sent[1]?.[0]).toBe("claude:opener");
});
