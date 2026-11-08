import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pending, post } from "./mailbox";
import {
  askParents,
  callerIdentity,
  findRecipient,
  flush,
  frame,
  NotNow,
  processAgent,
  route,
  type Transports,
} from "./messages";
import type { Session } from "./sessions";
import { kiln } from "./tmux";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function mailbox(): string {
  const root = mkdtempSync(join(tmpdir(), "kiln-messages-"));
  roots.push(root);
  return join(root, "mailbox.sqlite");
}

const session = (overrides: Partial<Session>): Session => ({
  agent: "claude",
  id: "c1",
  cwd: "/repo",
  startedAt: 0,
  activity: "idle",
  place: { kind: "kiln", name: "claude-1" },
  ...overrides,
});

test("the caller's own session id wins over one it inherited from the agent that started it", () => {
  const environment = { CLAUDE_CODE_SESSION_ID: "outer", CODEX_THREAD_ID: "inner" };
  expect(callerIdentity(environment, "codex")).toBe("codex:inner");
  expect(callerIdentity(environment, null)).toBeUndefined();
  expect(callerIdentity({ OPENCODE_SESSION_ID: "ses_1" }, null)).toBe("opencode:ses_1");
  expect(callerIdentity({}, "claude")).toBeUndefined();
  expect(processAgent(["/home/u/.local/bin/claude", "--resume", "x"])).toBe("claude");
  expect(processAgent(["/opt/codex/bin/codex", "app-server"])).toBe("codex");
  expect(processAgent(["node", "/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"])).toBe("pi");
  expect(processAgent(["zsh", "-c", "claude"])).toBeUndefined();
});

test("a recipient is found by full name or a unique prefix, never among stopped or cloud rows", () => {
  const sessions = [
    session({ id: "abc1" }),
    session({ id: "abc2" }),
    session({ agent: "codex", id: "xyz" }),
    session({ id: "gone", lifecycle: "completed" }),
    session({ id: "cloud", place: { kind: "cloud", id: "cloud", title: "t" } }),
  ];
  expect(findRecipient(sessions, "codex:xyz").id).toBe("xyz");
  expect(findRecipient(sessions, "xy").agent).toBe("codex");
  expect(() => findRecipient(sessions, "claude:abc")).toThrow("claude:abc1, claude:abc2");
  expect(() => findRecipient(sessions, "claude:gone")).toThrow("no running session");
  expect(() => findRecipient(sessions, "claude:cloud")).toThrow("no running session");
});

test("typing waits for an idle session; an agent's own queue takes a message at once", () => {
  expect(route(session({}))).toEqual({ push: "tmux" });
  expect(route(session({ activity: "waiting" }))).toEqual({ wait: "Claude is waiting" });
  expect(route(session({ activity: undefined }))).toEqual({ wait: "its status is unknown" });
  expect("inbox" in route(session({ place: { kind: "elsewhere" } }))).toBe(true);
  expect(route(session({ agent: "codex", activity: "working" }))).toEqual({ wait: "Codex is working" });
  expect(route(session({ activity: "working", turnEnded: true }))).toEqual({ push: "tmux" });
  expect(route(session({ agent: "codex", activity: "working", turnEnded: true }))).toEqual({ push: "codex" });
  expect(route(session({ agent: "codex", activity: "idle", place: { kind: "thread", id: "c1", attach: [] } }))).toEqual(
    {
      push: "codex",
    },
  );
  expect("inbox" in route(session({ agent: "codex", activity: undefined }))).toBe(true);
  expect(route(session({ agent: "opencode", activity: "working", opencodeService: true }))).toEqual({
    push: "opencode",
  });
  expect(route(session({ agent: "pi", pid: 7, activity: "working" }), (pid) => pid === 7)).toEqual({ push: "pi" });
  expect("inbox" in route(session({ agent: "pi", pid: 8 }), (pid) => pid === 7)).toBe(true);
});

test("flush types each deliverable message once, framed with its sender, and keeps the rest", async () => {
  const path = mailbox();
  const sender = session({ agent: "codex", id: "s1", title: "Fix login", cwd: "/work", place: { kind: "elsewhere" } });
  const idle = session({ id: "idle" });
  const busy = session({ id: "busy", activity: "working" });
  const typed: string[] = [];
  const send = {
    tmux: async (target: Session, text: string) => {
      if (target.id === "broken") throw new Error("pane closed");
      if (target.id === "open") throw new NotNow("someone has it open");
      typed.push(`${target.id}: ${text}`);
    },
  } as unknown as Transports;
  const sessions = [sender, idle, busy, session({ id: "broken" }), session({ id: "open" })];
  post("codex:s1", "claude:idle", "please review", path);
  post("codex:s1", "claude:busy", "later", path);
  post("codex:s1", "claude:broken", "lost?", path);
  post("codex:s1", "claude:missing", "nobody", path);
  post("codex:s1", "claude:open", "after you", path);
  const outcomes = await flush(sessions, { path, send });
  expect(typed).toEqual([
    `idle: [kiln message from codex:s1 ("Fix login" in /work)]\n\nplease review\n\n[Reply with: ${kiln} msg send codex:s1 "<your reply>"]`,
  ]);
  expect(outcomes.map((outcome) => (outcome.delivered ? "delivered" : outcome.reason))).toEqual([
    "delivered",
    "Claude is working",
    "pane closed; it may have arrived, so it is left for kiln msg inbox",
    "it is not running; it can read it later",
    "someone has it open",
  ]);
  expect(pending(path).map((message) => message.to)).toEqual(["claude:busy", "claude:missing", "claude:open"]);
  expect(await flush(sessions, { path, send })).toHaveLength(3);
  expect(typed).toHaveLength(1);
});

test("a message from a person at a shell offers no reply command", () => {
  const message = { id: "1", from: "terminal", to: "claude:a", body: "hi", createdAt: 0 };
  expect(frame(message, undefined)).toBe("[kiln message from terminal]\n\nhi");
  expect(frame({ ...message, from: "phone:Pixel 9" }, undefined)).toBe("[kiln message from phone:Pixel 9]\n\nhi");
  // The reply names the exact executable, quoted when its path needs it.
  expect(frame({ ...message, from: "pi:p" }, undefined, "/opt/my kiln/kiln")).toBe(
    "[kiln message from pi:p]\n\nhi\n\n[Reply with: '/opt/my kiln/kiln' msg send pi:p \"<your reply>\"]",
  );
});

test("a subagent's question goes once to the agent that started it, as a message its reply answers", () => {
  const path = mailbox();
  const parent = session({ id: "p1", pid: 10 });
  const child = session({
    agent: "opencode",
    id: "ses_1",
    pid: 11,
    parentSessionPid: 10,
    activity: "waiting",
    question: { id: "frm_1", text: "Which branch?" },
    place: { kind: "thread", id: "ses_1", attach: [] },
  });
  const quiet = { ...child, id: "ses_2", pid: 12, question: undefined };
  const send: typeof post = (from, to, body, _path, now, id) => post(from, to, body, path, now, id);
  const seen = new Set<string>();
  expect(askParents([parent, child, quiet], send, seen)).toBe(1);
  expect(askParents([parent, child, quiet], send, new Set())).toBe(1);
  expect(askParents([parent, child], send, seen)).toBe(0);
  const [message] = pending(path);
  expect(pending(path)).toHaveLength(1);
  expect(message).toMatchObject({ from: "opencode:ses_1", to: "claude:p1" });
  expect(message?.body).toContain("Which branch?");
  expect(askParents([child], send, new Set())).toBe(0);
});
