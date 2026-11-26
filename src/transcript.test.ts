import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "./transcript";

const record = (value: object) => `${JSON.stringify(value)}\n`;
const tool = (name: string, input: object) =>
  record({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("a generated title shows until the user sets one, and later generated titles do not replace it", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-titles-"));
  const path = join(root, "session.jsonl");
  try {
    writeFileSync(path, record({ type: "user", message: 'mentions "ai-title" in text' }));
    expect(readTranscript(path).title).toBeUndefined();
    appendFileSync(path, record({ type: "ai-title", aiTitle: "Kiln PRs to merge" }));
    expect(readTranscript(path).title).toBe("Kiln PRs to merge");
    appendFileSync(path, record({ type: "custom-title", customTitle: "Release 0.8.1" }));
    appendFileSync(path, record({ type: "ai-title", aiTitle: "Something newer" }));
    expect(readTranscript(path).title).toBe("Release 0.8.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conversation Claude started in Code Mode says so in its transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-code-mode-"));
  const path = join(root, "session.jsonl");
  try {
    writeFileSync(path, record({ type: "user", message: "mentions repl-mode in text" }));
    expect(readTranscript(path).codeMode).toBeUndefined();
    appendFileSync(path, record({ type: "repl-mode", replMode: true, sessionId: "s" }));
    expect(readTranscript(path).codeMode).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the working checkout follows the latest edit or cd, not reads or directories outside a repository", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-workdir-"));
  const path = join(root, "session.jsonl");
  const [main, worktree] = [join(root, "main"), join(root, "worktree")];
  for (const dir of [main, worktree]) mkdirSync(join(dir, ".git"), { recursive: true });
  try {
    writeFileSync(path, tool("Bash", { command: `cd ${worktree} && git status` }));
    expect(readTranscript(path).workdir).toBe(worktree);
    appendFileSync(path, tool("Read", { file_path: join(main, "README.md") }));
    // The filesystem root, since a machine's temporary directory can itself sit inside a repository.
    appendFileSync(path, tool("Bash", { command: "cd / && ls" }));
    expect(readTranscript(path).workdir).toBe(worktree);
    appendFileSync(path, tool("Edit", { file_path: join(main, "src", "app.ts") }));
    expect(readTranscript(path).workdir).toBe(main);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn has ended once Claude finishes a reply, until a prompt or a tool result follows it", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-turn-"));
  const path = join(root, "session.jsonl");
  const reply = (stop: string, sidechain = false) =>
    record({ type: "assistant", isSidechain: sidechain, message: { stop_reason: stop, content: [{ type: "text" }] } });
  try {
    writeFileSync(path, record({ type: "user", message: { role: "user", content: "start" } }));
    expect(readTranscript(path).turnEnded).toBe(false);
    appendFileSync(path, tool("Bash", { command: "sleep 900", run_in_background: true }));
    appendFileSync(path, record({ type: "user", message: { content: [{ type: "tool_result" }] } }));
    expect(readTranscript(path).turnEnded).toBe(false);
    // Waiting on a background shell or a wakeup: the reply ended the turn, and metadata after it changes nothing.
    appendFileSync(path, reply("end_turn"));
    appendFileSync(path, record({ type: "system", subtype: "stop_hook_summary" }));
    appendFileSync(path, record({ type: "pr-link", url: "https://github.com/o/r/pull/1" }));
    expect(readTranscript(path).turnEnded).toBe(true);
    appendFileSync(path, reply("end_turn", true));
    appendFileSync(path, record({ type: "user", isSidechain: true, message: { content: "subagent" } }));
    expect(readTranscript(path).turnEnded).toBe(true);
    // Compacting an idle conversation writes its summary as a user record, which is no prompt.
    appendFileSync(path, record({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }));
    appendFileSync(
      path,
      record({ type: "user", isCompactSummary: true, message: { role: "user", content: "summary" } }),
    );
    expect(readTranscript(path).turnEnded).toBe(true);
    appendFileSync(path, record({ type: "user", message: { role: "user", content: "next" } }));
    expect(readTranscript(path).turnEnded).toBe(false);
    appendFileSync(path, reply("tool_use"));
    expect(readTranscript(path).turnEnded).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a usage-limit refusal marks the conversation limited until the next prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-transcript-"));
  const path = join(root, "session.jsonl");
  const refusal = (extra: object) =>
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-20T10:00:00.000Z",
      error: "rate_limit",
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "limit" }] },
      ...extra,
    })}\n`;
  try {
    writeFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "start" } })}\n`);
    // The provider being busy carries no window, and is not a spent account.
    appendFileSync(path, refusal({}));
    expect(readTranscript(path).limited).toBeUndefined();
    appendFileSync(path, refusal({ quotaLimits: { status: "rejected", resetsAt: 1795200000 } }));
    expect(readTranscript(path).limited).toEqual({
      resetsAt: 1795200000_000,
      at: Date.parse("2026-11-20T10:00:00.000Z"),
    });
    appendFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "carry on" } })}\n`);
    expect(readTranscript(path).limited).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run told to wrap up is limited once its turn ends, until Claude Code takes the note back", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-wrap-up-"));
  const path = join(root, "session.jsonl");
  const user = (extra: object = {}) =>
    record({ type: "user", timestamp: "2026-11-20T10:00:00.000Z", message: { content: "text" }, ...extra });
  const reply = record({ type: "assistant", message: { content: [], stop_reason: "end_turn" } });
  const wrapped = { at: Date.parse("2026-11-20T10:00:00.000Z") };
  try {
    writeFileSync(path, user({ isMeta: true, usageLimitNote: "wrap_up" }));
    // The grace turn is still running.
    expect(readTranscript(path).limited).toBeUndefined();
    appendFileSync(path, reply);
    expect(readTranscript(path).limited).toEqual(wrapped);
    // A task notification answered from the same allowance does not mean the limit has gone.
    appendFileSync(path, user({ timestamp: "2026-11-20T10:05:00.000Z" }));
    expect(readTranscript(path).limited).toBeUndefined();
    appendFileSync(path, reply);
    expect(readTranscript(path).limited).toEqual(wrapped);
    const refusal = record({
      type: "assistant",
      timestamp: "2026-11-20T10:10:00.000Z",
      error: "rate_limit",
      isApiErrorMessage: true,
      quotaLimits: { resetsAt: 1795200000 },
    });
    appendFileSync(path, refusal + user() + reply);
    expect(readTranscript(path).limited).toEqual({ at: Date.parse("2026-11-20T10:10:00.000Z") });
    appendFileSync(path, user({ isMeta: true, usageLimitNote: "release" }) + reply);
    expect(readTranscript(path).limited).toBeUndefined();
    // A compaction that drops the note ends it at the next turn; until then the run is still wrapped up.
    const compacted = (kept: string[]) =>
      record({ type: "system", subtype: "compact_boundary", compactMetadata: { preservedMessages: { uuids: kept } } });
    appendFileSync(path, user({ uuid: "note", isMeta: true, usageLimitNote: "wrap_up" }) + reply);
    appendFileSync(path, compacted(["note"]) + user() + reply);
    expect(readTranscript(path).limited).toEqual(wrapped);
    appendFileSync(path, compacted([]));
    expect(readTranscript(path).limited).toEqual(wrapped);
    appendFileSync(path, user() + reply);
    expect(readTranscript(path).limited).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new process carries on from where any kiln process last read a transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-shared-"));
  const path = join(root, "session.jsonl");
  const titled = record({ type: "ai-title", aiTitle: "First title" });
  // Each read is its own process, as each `kiln msg list` is, so only the shared store links them.
  const read = () =>
    JSON.parse(
      Bun.spawnSync(
        [
          "bun",
          "-e",
          `console.log(JSON.stringify(require(${JSON.stringify(require.resolve("./transcript"))}).readTranscript(${JSON.stringify(path)})))`,
        ],
        { env: { ...Bun.env, XDG_CACHE_HOME: join(root, "cache") } },
      ).stdout.toString(),
    );
  try {
    writeFileSync(path, titled);
    expect(read().title).toBe("First title");
    // Blank the record already read, in place: a process that read from the start again would lose the title.
    writeFileSync(path, `${" ".repeat(titled.length - 1)}\n`);
    appendFileSync(path, record({ type: "user", message: { role: "user", content: "next" } }));
    expect(read()).toEqual({ title: "First title", turnEnded: false });
    // A transcript replaced by another file is read from its start.
    writeFileSync(join(root, "next.jsonl"), record({ type: "ai-title", aiTitle: "Second title" }));
    renameSync(join(root, "next.jsonl"), path);
    expect(read()).toEqual({ title: "Second title" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
