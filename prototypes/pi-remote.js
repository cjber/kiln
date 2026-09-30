import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Load explicitly with pi -e. The local gateway connects through the owner's private socket. */
export default function remote(pi) {
  let context;
  let directory;
  let server;
  const clients = new Set();

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
            switch (request.type) {
              case "get_state":
                send(client, {
                  type: "response",
                  id: request.id,
                  success: true,
                  data: {
                    sessionId: context.sessionManager.getSessionId(),
                    cwd: context.cwd,
                    idle: context.isIdle(),
                    branch: context.sessionManager.getBranch().slice(-200),
                  },
                });
                break;
              case "prompt":
                if (typeof request.message !== "string" || !request.message.trim())
                  throw new Error("message is required");
                if (!context.isIdle()) throw new Error("session is busy; wait before sending a prompt");
                pi.sendUserMessage(request.message, { expandPromptTemplates: false });
                send(client, { type: "response", id: request.id, success: true });
                break;
              case "abort":
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
      writeFileSync(join(directory, "session.json"), JSON.stringify({ pid: process.pid, socket, cwd: ctx.cwd }), {
        mode: 0o600,
      });
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
      for (const client of clients) send(client, { type: "event", event: record });
    });
  }
  for (const event of ["session_switch", "session_fork", "session_tree"]) {
    pi.on(event, (_record, ctx) => {
      context = ctx;
    });
  }
  pi.on("session_shutdown", () => {
    cleanup();
    context?.ui.setStatus("kiln-remote", undefined);
  });
}
