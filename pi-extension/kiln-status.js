// kiln loads this into the Pi sessions it starts (`pi -e`). It reports the session's identity,
// title and activity to a private file that kiln's session list reads.
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function status(pi) {
  const directory = process.env.KILN_PI_STATUS_DIR || join(process.env.XDG_RUNTIME_DIR || tmpdir(), "kiln-pi");
  const path = join(directory, `${process.pid}.json`);
  let running = false;
  let prompts = 0;

  function firstPrompt(manager) {
    for (const entry of manager.getBranch()) {
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      const text = typeof content === "string" ? content : content?.find((part) => part.type === "text")?.text;
      const line = text?.trim().split("\n")[0];
      if (line) return line.slice(0, 80);
    }
    return undefined;
  }

  function write(ctx) {
    const manager = ctx.sessionManager;
    const record = {
      pid: process.pid,
      // The process start time tells kiln this file is not a leftover from a reused pid.
      startedAt: Math.trunc(statSync(`/proc/${process.pid}`).mtimeMs),
      sessionId: manager.getSessionId(),
      title: manager.getSessionName() ?? firstPrompt(manager),
      activity: prompts ? "waiting" : running ? "working" : "idle",
      updatedAt: Date.now(),
    };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  pi.on("session_start", (_event, ctx) => write(ctx));
  pi.on("session_info_changed", (_event, ctx) => write(ctx));
  pi.on("agent_start", (_event, ctx) => {
    running = true;
    write(ctx);
  });
  // Retries, compaction and queued work can follow `agent_end`; only a settled run is idle.
  pi.on("agent_settled", (_event, ctx) => {
    running = false;
    write(ctx);
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    prompts++;
    write(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    prompts = Math.max(0, prompts - 1);
    write(ctx);
  });
  pi.on("session_shutdown", () => rmSync(path, { force: true }));
}
