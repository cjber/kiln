import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const id = "fixture";
agent({ name: "kiln ACP fixture" })
  .onRequest("initialize", () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  .onRequest("session/new", async () => {
    await Bun.sleep(Number(process.argv[2] ?? 0));
    return { sessionId: id };
  })
  .onRequest("session/load", () => ({}))
  .onRequest("session/prompt", async ({ params, client }) => {
    await client.notify("session/update", {
      sessionId: id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking the request. " } },
    });
    if (params.prompt.some((block) => block.type === "text" && block.text.includes("approve"))) {
      const permission = await client.request("session/request_permission", {
        sessionId: id,
        toolCall: { toolCallId: "read", title: "Read project files", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      await client.notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: permission.outcome.outcome === "selected" ? "Permission answered." : "Cancelled.",
          },
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
