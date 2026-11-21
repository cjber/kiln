import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pending, post, posted } from "./mailbox";
import {
  approvalShown,
  askParents,
  callerIdentity,
  findRecipient,
  flush,
  frame,
  HeldForApproval,
  heldBecause,
  lastExit,
  NotNow,
  phoneSender,
  processAgent,
  replyCommand,
  reportTurnEnd,
  route,
  spawnSender,
  type Transports,
  typedText,
} from "./messages";
import type { Saved } from "./saved-sessions";
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
  expect(processAgent(["/home/u/.local/bin/muse", "exec"])).toBe("muse");
  expect(processAgent(["/home/u/.local/bin/muse-bin-1.4.23", "resume", "x"])).toBe("muse");
  expect(callerIdentity({ MUSE_SESSION_ID: "m1" }, "muse")).toBe("muse:m1");
  expect(processAgent(["agy", "-p", "x"])).toBe("agy");
  expect(callerIdentity({ ANTIGRAVITY_CONVERSATION_ID: "a1" }, "agy")).toBe("agy:a1");
  expect(callerIdentity({ MUSE_SESSION_ID: "m1", CLAUDE_CODE_SESSION_ID: "c1" }, null)).toBeUndefined();
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

test("a send to a spawned child that has exited names its exit, not a missing session", () => {
  const report = {
    id: "exit:claude:gone:1000",
    from: `${spawnSender}:claude:gone`,
    to: "claude:parent",
    body: 'Child claude:gone exited with status 4 while working on "t".\n\nLast output:\n\nboom',
    createdAt: Date.UTC(2026, 10, 18, 9, 30),
  };
  const exited = (name: string) => (name === "claude:gone" ? report : undefined);
  expect(() => findRecipient([], "claude:gone", exited)).toThrow(
    'claude:gone has exited; kiln reported at 2026-11-18T09:30:00.000Z: Child claude:gone exited with status 4 while working on "t".',
  );
  expect(() => findRecipient([], "claude:gnoe", exited)).toThrow("no running session is called claude:gnoe");
});

test("a name a failed listing may have left out is not called unknown, and one it could not have is", () => {
  // `claude agents` timing out lists no Claude at all in a one-shot command, so absence there proves nothing (#277).
  const report = { id: "exit:1", from: `${spawnSender}:codex:done`, to: "claude:parent", body: "exited", createdAt: 1 };
  const exited = (name: string) => (name === "codex:done" || name === "claude:done" ? report : undefined);
  const failed = { reason: "claude agents failed or timed out", agent: "claude" as const };
  const unknown = "claude agents failed or timed out, so kiln cannot tell whether";
  expect(() => findRecipient([], "claude:busy", exited, failed)).toThrow(`${unknown} claude:busy is running`);
  expect(() => findRecipient([], "bus", exited, failed)).toThrow(`${unknown} bus is running`);
  // Another agent's sessions were listed, and a child's own exit report still says what happened to it.
  expect(() => findRecipient([], "codex:typo", exited, failed)).toThrow("no running session is called codex:typo");
  expect(() => findRecipient([], "codex:done", exited, failed)).toThrow("codex:done has exited");
  expect(() => findRecipient([], "claude:done", exited, failed)).toThrow("claude:done has exited");
  // With every source failed, no agent's absence is known.
  expect(() => findRecipient([], "codex:typo", exited, { reason: "discovery failed" })).toThrow("cannot tell");
});

test("a resumed child is not refused on the exit report of the run before it (#277)", () => {
  const report = {
    id: "exit:claude:back:1000",
    from: `${spawnSender}:claude:back`,
    to: "claude:parent",
    body: "Child claude:back exited with status 137.",
    createdAt: 2_000,
  };
  expect(lastExit("claude:back", report, undefined)).toBe(report);
  expect(lastExit("claude:back", report, { startedAt: 1_000 } as Saved)).toBe(report);
  // The resume recorded a run that started after the report, so the report is about a run that is over.
  expect(lastExit("claude:back", report, { startedAt: 3_000 } as Saved)).toBeUndefined();
  expect(() =>
    findRecipient([], "claude:back", () => lastExit("claude:back", report, { startedAt: 3_000 } as Saved)),
  ).toThrow("no running session is called claude:back");
});

test("a spawned Codex run answers to the process name its spawn returned and to its thread id", () => {
  const run = session({ agent: "codex", id: "0193-thread", pid: 40, startedAt: 7.5, activity: undefined });
  expect(findRecipient([run], "codex:40:7.5")).toBe(run);
  expect(findRecipient([run], "codex:0193-thread")).toBe(run);
  // Codex exec has no queue to push into, so the message waits in the mailbox the run reads with `kiln msg inbox`.
  expect(route(run)).toEqual({ inbox: "it is not on Codex's shared daemon" });
  expect(() => findRecipient([{ ...run, id: undefined }], "codex:40:7.5")).toThrow("no running session");
});

test("the person's own phone message is typed into a kiln Claude as their prompt, not sent as a peer's", () => {
  const phone = phoneSender("Pixel 9a");
  const message = { id: "1", from: "terminal", to: "claude:a", body: "hi", createdAt: 0 };
  // Claude frames anything its inbox takes as another session's message, so the person's words wait for the prompt.
  expect(route(session({ claudeInbox: true }), undefined, phone)).toEqual({ push: "tmux" });
  expect(route(session({ claudeInbox: true, activity: "working" }), undefined, phone)).toEqual({
    wait: "Claude is working",
  });
  expect(route(session({ claudeInbox: true, activity: "working", turnEnded: true }), undefined, phone)).toEqual({
    push: "tmux",
  });
  // Another session's message still queues in Claude's inbox while a turn runs.
  expect(route(session({ claudeInbox: true, activity: "working" }), undefined, "claude:other")).toEqual({
    push: "claude",
  });
  // Outside kiln there is no terminal to type into, so the inbox is the only way in.
  expect(route(session({ claudeInbox: true, place: { kind: "elsewhere" } }), undefined, phone)).toEqual({
    push: "claude",
  });
  expect(typedText({ ...message, from: phone }, undefined)).toBe("hi");
  expect(typedText({ ...message, from: "claude:other" }, undefined)).toBe(
    frame({ ...message, from: "claude:other" }, undefined),
  );
});

test("typing waits for an idle session; an agent's own queue takes a message at once", () => {
  expect(route(session({}))).toEqual({ push: "tmux" });
  // A stopped process reads nothing, its own queue included, so nothing is delivered to it (#280).
  for (const paused of [session({ paused: true }), session({ paused: true, claudeInbox: true })])
    expect(route(paused)).toEqual({ wait: "its process is stopped; it is delivered once the process continues" });
  expect(route(session({ activity: "waiting" }))).toEqual({ wait: "Claude is waiting" });
  expect(route(session({ activity: undefined }))).toEqual({ wait: "its status is unknown" });
  expect("inbox" in route(session({ place: { kind: "elsewhere" } }))).toBe(true);
  expect(route(session({ agent: "codex", activity: "working" }))).toEqual({ push: "codex" });
  expect(route(session({ agent: "codex", activity: "waiting" }))).toEqual({ wait: "Codex is waiting" });
  expect(route(session({ activity: "working", turnEnded: true }))).toEqual({ push: "tmux" });
  expect(route(session({ agent: "codex", activity: "working", turnEnded: true }))).toEqual({ push: "codex" });
  expect(route(session({ agent: "codex", activity: "idle", place: { kind: "thread", id: "c1", attach: [] } }))).toEqual(
    {
      push: "codex",
    },
  );
  expect("inbox" in route(session({ agent: "codex", activity: undefined }))).toBe(true);
  // A working exec run reports its status but has no daemon to take the message.
  expect("inbox" in route(session({ agent: "codex", activity: "working", codexExec: true }))).toBe(true);
  expect(route(session({ agent: "opencode", activity: "working", opencodeService: true }))).toEqual({
    push: "opencode",
  });
  expect(route(session({ agent: "pi", pid: 7, activity: "working" }), (pid) => pid === 7)).toEqual({ push: "pi" });
  // Claude's inbox queues a message mid-turn and reaches a session kiln did not start; only a question holds it.
  const inbox = { claudeInbox: true, place: { kind: "elsewhere" } } as const;
  expect(route(session({ ...inbox, activity: "working" }))).toEqual({ push: "claude" });
  expect(route(session({ ...inbox, activity: undefined }))).toEqual({ push: "claude" });
  expect(route(session({ ...inbox, activity: "waiting" }))).toEqual({ wait: "Claude is waiting" });
  expect("inbox" in route(session({ agent: "pi", pid: 8 }), (pid) => pid === 7)).toBe(true);
  // Muse's session messaging takes a message at once; an exec run has no live session to take one.
  expect(route(session({ agent: "muse", activity: undefined }))).toEqual({ push: "muse" });
  expect(route(session({ agent: "muse", activity: "working" }))).toEqual({ push: "muse" });
  expect("inbox" in route(session({ agent: "muse", activity: "working", museExec: true }))).toBe(true);
  expect("inbox" in route(session({ agent: "muse", id: undefined }))).toBe(true);
  // agy has no push transport: kiln types into its own pane once its summary row says idle.
  expect(route(session({ agent: "agy", activity: "idle" }))).toEqual({ push: "tmux" });
  expect(route(session({ agent: "agy", activity: "working" }))).toEqual({ wait: "Agy is working" });
  expect(route(session({ agent: "agy", activity: "waiting" }))).toEqual({ wait: "Agy is waiting" });
  expect("inbox" in route(session({ agent: "agy", activity: "idle", agyExec: true }))).toBe(true);
  expect("inbox" in route(session({ agent: "agy", activity: "idle", place: { kind: "elsewhere" } }))).toBe(true);
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
      if (target.id === "open") throw new NotNow("someone is typing in its terminal");
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
    "someone is typing in its terminal",
  ]);
  expect(pending(path).map((message) => message.to)).toEqual(["claude:busy", "claude:missing", "claude:open"]);
  expect(await flush(sessions, { path, send })).toHaveLength(3);
  expect(typed).toHaveLength(1);
});

test("a message Claude holds at its approval prompt says so, rather than that it may be lost", async () => {
  const path = mailbox();
  const send = {
    tmux: async (target: Session) => {
      throw new HeldForApproval(`held at Claude's message approval prompt in claude:${target.id}; approve it there`);
    },
  } as unknown as Transports;
  post("terminal", "claude:held", "hello", path);
  const [outcome] = await flush([session({ id: "held" })], { path, send });
  expect(outcome?.delivered ? "delivered" : outcome?.reason).toBe(
    "held at Claude's message approval prompt in claude:held; approve it there",
  );
  // Claude delivers it once approved, so kiln does not send it again.
  expect(pending(path)).toEqual([]);
});

test("Claude's pane shows its prompt for a held message", () => {
  const prompt = [
    "Another Claude session sent a message: from claude:293a92c1 [verified pid 54331]",
    "This session is not prompting for permissions.",
    "Message body (this is what will be delivered)",
    "❯ 1. Deny — drop it and tell the sender it was declined",
    "  2. Deliver this message to Claude",
  ].join("\n");
  expect(approvalShown(prompt)).toBe(true);
  expect(approvalShown("❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)")).toBe(false);
});

test("a message from a person at a shell offers no reply command", () => {
  const message = { id: "1", from: "terminal", to: "claude:a", body: "hi", createdAt: 0 };
  expect(frame(message, undefined)).toBe("[kiln message from terminal]\n\nhi");
  expect(frame({ ...message, from: "phone:Pixel 9" }, undefined)).toBe("[kiln message from phone:Pixel 9]\n\nhi");
  expect(frame({ ...message, from: spawnSender }, undefined)).toBe(`[kiln message from ${spawnSender}]\n\nhi`);
  expect(frame({ ...message, from: `${spawnSender}:claude:child` }, undefined)).toBe(
    `[kiln message from ${spawnSender}:claude:child]\n\nhi`,
  );
  // The reply names the exact executable, quoted when its path needs it.
  expect(frame({ ...message, from: "pi:p" }, undefined, "/opt/my kiln/kiln")).toBe(
    "[kiln message from pi:p]\n\nhi\n\n[Reply with: '/opt/my kiln/kiln' msg send pi:p \"<your reply>\"]",
  );
});

test("a peer outside kiln gets a reply command that names its mailbox", () => {
  const message = { id: "1", from: "@nebula", to: "opencode:ses_1", body: "hi", createdAt: 0 };
  expect(frame(message, undefined, "kiln")).toBe(
    '[kiln message from @nebula]\n\nhi\n\n[Reply with: kiln msg send @nebula "<your reply>"]',
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

test("only a wait that ends by itself is reported to the phone as one", () => {
  expect(heldBecause(session({ activity: "working" }))).toBe("Claude is working");
  // A mailbox reader or a stopped session never takes it by itself, so nothing claims it will send.
  expect(heldBecause(session({ place: { kind: "elsewhere" } }))).toBeUndefined();
  expect(heldBecause(session({ lifecycle: "completed" }))).toBeUndefined();
});

test("a slow recipient cannot block another, while each recipient keeps its message order", async () => {
  const path = mailbox();
  const first = post("claude:sender", "codex:slow", "first", path);
  const second = post("claude:sender", "codex:slow", "second", path);
  const fast = post("claude:sender", "codex:fast", "fast", path);
  const started: string[] = [];
  let unblock = () => {};
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let fastDone = () => {};
  const fastFinished = new Promise<void>((resolve) => {
    fastDone = resolve;
  });
  const send = {
    codex: async (_target: Session, _text: string, message: { body: string }) => {
      started.push(message.body);
      if (message.body === "first") await blocked;
      if (message.body === "fast") fastDone();
    },
  } as unknown as Transports;
  const flushing = flush([session({ agent: "codex", id: "slow" }), session({ agent: "codex", id: "fast" })], {
    path,
    send,
  });
  try {
    await Promise.race([
      fastFinished,
      Bun.sleep(100).then(() => {
        throw new Error("unrelated recipient blocked");
      }),
    ]);
    expect(started).toEqual(["first", "fast"]);
  } finally {
    unblock();
    await flushing;
  }
  expect(started).toEqual(["first", "fast", "second"]);
  expect((await flushing).map((outcome) => outcome.message.id)).toEqual([first.id, second.id, fast.id]);
});

test("a direct send flushes only its recipients and leaves unrelated messages unclaimed", async () => {
  const path = mailbox();
  const unrelated = post("claude:sender", "codex:slow", "later", path);
  post("claude:sender", "codex:fast", "now", path);
  const touched: string[] = [];
  const send = {
    codex: async (target: Session) => {
      touched.push(target.id ?? "");
    },
  } as unknown as Transports;
  const outcomes = await flush([session({ agent: "codex", id: "slow" }), session({ agent: "codex", id: "fast" })], {
    path,
    send,
    recipients: new Set(["codex:fast"]),
  });
  expect(touched).toEqual(["fast"]);
  expect(outcomes).toHaveLength(1);
  expect(posted(unrelated.id, path)?.deliveredAt).toBeUndefined();
  expect(pending(path).map((message) => message.id)).toEqual([unrelated.id]);
});

test("a reply names this kiln while its executable exists, and the kiln on PATH once it is gone (#290)", () => {
  expect(replyCommand(kiln)).toBe(kiln);
  const removed = join(mailbox(), "removed-install", "kiln");
  expect(replyCommand(removed)).toBe(Bun.which("kiln") ?? "kiln");
});

test("a child that ends its turn silently is reported to its parent once per reply, with how to close it", () => {
  const path = mailbox();
  const parent = session({ id: "p1", pid: 10, activity: "working" });
  const child = session({
    id: "c2",
    pid: 11,
    parentSessionPid: 10,
    title: "fix it",
    place: { kind: "kiln", name: "claude-c2" },
  });
  const send: typeof post = (from, to, body, _path, now, id) => post(from, to, body, path, now, id);
  const turn = () => ({ started: 1_000, reply: { id: "r1", text: "Done: PR opened." } });
  const never = () => false;
  expect(reportTurnEnd(child, parent, send, turn, never, never)).toBe(true);
  expect(reportTurnEnd(child, parent, send, turn, never, never)).toBe(true);
  const [report] = pending(path);
  expect(pending(path)).toHaveLength(1);
  expect(report).toMatchObject({ to: "claude:p1" });
  expect(report?.body).toContain("Done: PR opened.");
  expect(report?.body.endsWith("kiln close claude:c2")).toBe(true);
  // A child that messaged its parent during the turn has reported already.
  const later = () => ({ started: 2_000, reply: { id: "r2", text: "more" } });
  expect(
    reportTurnEnd(
      child,
      parent,
      send,
      later,
      (from, to, since) => from === "claude:c2" && to === "claude:p1" && since === 2_000,
      never,
    ),
  ).toBe(false);
  // A headless child's exit report carries its last output, so its turn end is not reported twice.
  expect(reportTurnEnd(child, parent, send, later, never, () => true)).toBe(false);
  // A child waiting on an approval is told apart, and closing it is not suggested.
  expect(reportTurnEnd({ ...child, activity: "waiting" }, parent, send, later, never, never)).toBe(true);
  const waiting = pending(path).find((message) => message.body.includes("more"));
  expect(waiting?.body).toContain("waiting on input or an approval");
  expect(waiting?.body).not.toContain("kiln close");
});
