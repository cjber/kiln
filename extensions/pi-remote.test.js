import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import remote from "./pi-remote.js";

test("private Pi bridge validates JSONL, rejects busy prompts, forwards events and cleans up", async () => {
  const handlers = new Map();
  const prompts = [];
  let idle = true;
  let aborted = false;
  const ctx = {
    cwd: "/tmp",
    isIdle: () => idle,
    abort: () => {
      aborted = true;
    },
    sessionManager: { getSessionId: () => "fixture", getBranch: () => [], getSessionName: () => "Fixture title" },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  remote({ on: (event, handler) => handlers.set(event, handler), sendUserMessage: (message) => prompts.push(message) });
  const root = process.env.XDG_RUNTIME_DIR || tmpdir();
  const before = new Set(readdirSync(root));
  handlers.get("session_start")({}, ctx);
  const directory = join(
    root,
    readdirSync(root).find((name) => name.startsWith("kiln-pi-") && !before.has(name)),
  );
  let client;
  try {
    for (let tries = 0; tries < 100 && !existsSync(join(directory, "session.json")); tries++) await Bun.sleep(5);
    const descriptor = JSON.parse(readFileSync(join(directory, "session.json"), "utf8"));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(descriptor.socket).mode & 0o777).toBe(0o600);
    client = createConnection(descriptor.socket);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.setEncoding("utf8");
    const records = [];
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        records.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const wait = async (count) => {
      for (let tries = 0; tries < 100 && records.length < count; tries++) await Bun.sleep(5);
      expect(records).toHaveLength(count);
    };
    client.write('{"id":"a","type":"get_');
    client.write('state"}\nnull\n{"id":"b","type":"delete"}\n');
    await wait(3);
    expect(records[0].data.sessionId).toBe("fixture");
    expect(records[1].success).toBe(false);
    expect(records[2].success).toBe(false);
    idle = false;
    client.write('{"id":"c","type":"prompt","writer":"000000000000000000000001","message":"hi"}\n');
    await wait(4);
    expect(records[3].error).toContain("busy");
    expect(prompts).toEqual([]);
    idle = true;
    client.write(
      '{"id":"d","type":"prompt","writer":"000000000000000000000001","message":"hello"}\n{"type":"abort","writer":"000000000000000000000001"}\n',
    );
    await wait(6);
    expect(prompts).toEqual(["hello"]);
    expect(aborted).toBe(true);
    handlers.get("message_update")({ type: "message_update", text: "result" }, ctx);
    await wait(7);
    expect(records[6].type).toBe("event");
    client.write('{"id":"d","type":"prompt","writer":"000000000000000000000001","message":"hello"}\n');
    await wait(8);
    expect(prompts).toEqual(["hello"]);
    client.write('{"id":"e","type":"abort","writer":"000000000000000000000002"}\n');
    await wait(9);
    expect(records[8].success).toBe(false);
    expect(records[8].error).toContain("another phone");
    client.write(
      '{"id":"f","type":"prompt","writer":"000000000000000000000001","sessionId":"stale","message":"wrong thread"}\n',
    );
    await wait(10);
    expect(records[9].error).toContain("switched sessions");
    expect(prompts).toEqual(["hello"]);
  } finally {
    client?.destroy();
    handlers.get("session_shutdown")();
  }
  expect(existsSync(directory)).toBe(false);
});
