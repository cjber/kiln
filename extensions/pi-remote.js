// kiln-managed Pi remote extension
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Load explicitly with pi -e. The local gateway connects through the owner's private socket. */
export default function remote(pi) {
  let context;
  let directory;
  let server;
  const clients = new Set();
  const instance = randomUUID();
  let sequence = 0;
  let updatedAt;
  let writer;
  let leaseUntil = 0;
  let pendingPrompt = false;
  let streaming;
  const replies = new Map();

  function state(transcript) {
    const branch = context.sessionManager.getBranch();
    const last = branch.at(-1);
    const timestamp = last?.timestamp ? Date.parse(last.timestamp) : undefined;
    const entries = streaming ? [...branch, { type: "message", message: streaming }] : branch;
    const messages = transcript
      ? entries
          .filter((entry) => entry.type === "message")
          .slice(-40)
          .map(({ message }) => ({
            role: message.role,
            text:
              typeof message.content === "string"
                ? message.content.slice(-4000)
                : (message.content ?? [])
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                    .slice(-4000),
          }))
      : undefined;
    return {
      instance,
      sequence,
      sessionId: context.sessionManager.getSessionId(),
      title: context.sessionManager.getSessionName(),
      cwd: context.cwd,
      activity: pendingPrompt || !context.isIdle() ? "working" : "idle",
      updatedAt: updatedAt ?? (Number.isFinite(timestamp) ? timestamp : undefined),
      messages,
      writer: leaseUntil > Date.now() ? writer : undefined,
      localAction: "Extension dialogs must be answered in the local terminal",
    };
  }

  function lease(request, claim = false) {
    if (!/^[a-f0-9]{24}$/.test(request.writer ?? "")) throw new Error("paired writer is required");
    if (leaseUntil > Date.now() && writer !== request.writer) {
      if (claim) throw new Error("another phone controls this session; wait for its lease to expire");
      return;
    }
    if (claim || writer === request.writer) {
      writer = request.writer;
      leaseUntil = Date.now() + 30_000;
    }
  }

  function send(client, record) {
    if (client.writableLength > 1_048_576) return client.destroy();
    client.write(`${JSON.stringify(record)}\n`);
  }

  function cleanup() {
    for (const client of clients) client.destroy();
    clients.clear();
    server?.close();
    server = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (server) return;
    directory = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "kiln-pi-"));
    const socket = join(directory, "control.sock");
    server = createServer((client) => {
      clients.add(client);
      client.setEncoding("utf8");
      let buffer = "";
      client.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 65_536) return client.destroy();
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let request;
          try {
            request = JSON.parse(line);
            if (!request || typeof request !== "object") throw new Error("expected an object");
            if (request.sessionId && request.sessionId !== context.sessionManager.getSessionId())
              throw new Error("Pi switched sessions; refresh before sending a command");
            switch (request.type) {
              case "get_state":
                if (request.writer) lease(request);
                send(client, {
                  type: "response",
                  id: request.id,
                  success: true,
                  data: state(request.transcript === true),
                });
                break;
              case "prompt": {
                if (typeof request.message !== "string" || !request.message.trim())
                  throw new Error("message is required");
                lease(request, true);
                if (typeof request.id !== "string" || request.id.length > 64) throw new Error("request ID is required");
                const key = `${request.writer}:${request.id}`;
                if (!replies.has(key)) {
                  if (pendingPrompt || !context.isIdle())
                    throw new Error("session is busy; wait before sending a prompt");
                  pendingPrompt = true;
                  try {
                    pi.sendUserMessage(request.message, { expandPromptTemplates: false });
                  } catch {
                    pendingPrompt = false;
                    throw new Error("Pi could not queue the prompt; check the local terminal");
                  }
                  replies.set(key, true);
                  if (replies.size > 128) replies.delete(replies.keys().next().value);
                }
                send(client, { type: "response", id: request.id, success: true });
                break;
              }
              case "abort":
                lease(request, true);
                context.abort();
                send(client, { type: "response", id: request.id, success: true });
                break;
              default:
                throw new Error("supported commands: get_state, prompt, abort");
            }
          } catch (error) {
            send(client, { type: "response", id: request?.id, success: false, error: String(error) });
          }
        }
      });
      client.on("error", () => client.destroy());
      client.on("close", () => clients.delete(client));
    });
    server.on("error", (error) => {
      cleanup();
      ctx.ui.notify(`kiln remote: ${error.message}`, "error");
    });
    server.listen(socket, () => {
      chmodSync(socket, 0o600);
      writeFileSync(
        join(directory, "session.json"),
        JSON.stringify({ pid: process.pid, socket, startedAt: statSync(`/proc/${process.pid}`).mtimeMs }),
        {
          mode: 0o600,
        },
      );
      ctx.ui.setStatus("kiln-remote", `remote: ${socket}`);
    });
  });

  for (const event of [
    "agent_start",
    "agent_end",
    "agent_settled",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
  ]) {
    pi.on(event, (record, ctx) => {
      context = ctx;
      sequence++;
      updatedAt = Date.now();
      if (event === "message_update") streaming = record.message;
      if (["message_end", "agent_end", "agent_settled"].includes(event)) streaming = undefined;
      if (["agent_end", "agent_settled"].includes(event)) pendingPrompt = false;
      for (const client of clients) send(client, { type: "event", event: record });
    });
  }
  for (const event of ["session_switch", "session_fork", "session_tree"]) {
    pi.on(event, (_record, ctx) => {
      context = ctx;
      pendingPrompt = false;
      streaming = undefined;
      updatedAt = undefined;
      sequence++;
      writer = undefined;
      leaseUntil = 0;
      replies.clear();
    });
  }
  pi.on("session_shutdown", () => {
    cleanup();
    context?.ui.setStatus("kiln-remote", undefined);
  });
}
