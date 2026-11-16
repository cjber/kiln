/** Isolated protocol and transport smoke. Never touches existing agent mailboxes. */
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// Pass a checkout path to compare the same fixtures against main and a fix branch.
const repo = resolve(Bun.argv[2] ?? join(import.meta.dir, ".."));
const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "kiln-messaging-smoke-"));
Bun.env.XDG_STATE_HOME = root;
Bun.env.CODEX_HOME = root;
const { post, pending } = await import(`${repo}/src/mailbox.ts`);
const { flush } = await import(`${repo}/src/messages.ts`);
const session = (id: string, activity = "idle") => ({
  agent: "codex",
  id,
  cwd: "/repo",
  startedAt: 0,
  activity,
  place: { kind: "thread", id, attach: [] },
});
const results: unknown[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  mkdirSync(join(root, "app-server-control"));
  const calls: string[] = [];
  server = Bun.serve({
    unix: join(root, "app-server-control/app-server-control.sock"),
    fetch(r, s) {
      if (s.upgrade(r, { data: undefined })) return;
      return new Response("", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const r = JSON.parse(String(data));
        if (!r.id) return;
        calls.push(r.method);
        let result: object = {};
        if (r.method === "thread/read")
          result = {
            thread: { status: { type: "active", activeFlags: [] }, turns: [{ id: "busy-turn", status: "inProgress" }] },
          };
        if (r.method === "thread/turns/list") result = { data: [{ id: "busy-turn", status: "inProgress" }] };
        ws.send(JSON.stringify({ id: r.id, result }));
      },
    },
  });
  const path = join(root, "active.sqlite");
  post("codex:sender", "codex:busy", "reply while working", path);
  let t = performance.now();
  const active = await flush([session("busy", "working")], { path });
  results.push({
    scenario: "active Codex reply",
    ms: Math.round(performance.now() - t),
    delivered: active[0]?.delivered,
    wire: calls,
    pending: pending(path).length,
  });
  const many = join(root, "many.sqlite");
  const sessions = Array.from({ length: 8 }, (_, i) => session(String(i)));
  for (const s of sessions) post("codex:sender", `codex:${s.id}`, "ping", many);
  t = performance.now();
  await flush(sessions, {
    path: many,
    send: {
      codex: async () => {
        await Bun.sleep(100);
      },
    },
  });
  results.push({
    scenario: "eight recipients, 100ms transport each",
    ms: Math.round(performance.now() - t),
    pending: pending(many).length,
  });
  const selected = join(root, "selected.sqlite");
  post("codex:sender", "codex:slow", "unrelated", selected);
  post("codex:sender", "codex:fast", "reply", selected);
  const touched: string[] = [];
  t = performance.now();
  await flush([session("slow"), session("fast")], {
    path: selected,
    recipients: new Set(["codex:fast"]),
    send: {
      codex: async (s: { id: string }) => {
        touched.push(s.id);
        if (s.id === "slow") await Bun.sleep(300);
      },
    },
  });
  results.push({
    scenario: "send to fast recipient behind unrelated slow message",
    ms: Math.round(performance.now() - t),
    touched,
    pending: pending(selected).length,
  });
  const actual = await import(`${repo}/src/sessions.ts`);
  let discoveries = 0;
  mock.module(`${repo}/src/sessions.ts`, () => ({
    ...actual,
    discovery: () => async () => {
      discoveries++;
      await Bun.sleep(300);
      return { sessions: [] };
    },
  }));
  const { runMsgCli } = await import(`${repo}/src/msg-cli.ts`);
  post("@sender", "@reader", "reply");
  t = performance.now();
  await runMsgCli(["inbox", "--as", "@reader", "--json"]);
  results.push({ scenario: "JSON inbox, discovery delayed 300ms", ms: Math.round(performance.now() - t), discoveries });
  t = performance.now();
  await runMsgCli(["send", "@receiver", "ping", "--as", "@sender", "--json"]);
  results.push({ scenario: "peer send, discovery delayed 300ms", ms: Math.round(performance.now() - t), discoveries });
  console.log(JSON.stringify({ repo, results }, null, 2));
} finally {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
