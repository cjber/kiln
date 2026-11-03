import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isOpencodeService,
  newOpencodeSessionId,
  opencodeActivity,
  opencodeInvocation,
  opencodeService,
  opencodeSessions,
  opencodeShown,
} from "./opencode";

function serviceFile(dir: string, record: unknown): string {
  mkdirSync(join(dir, "opencode"), { recursive: true });
  const path = join(dir, "opencode", "service.json");
  writeFileSync(path, JSON.stringify(record));
  return path;
}

test("the service's password is only sent to a loopback address", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  try {
    const local = opencodeService(serviceFile(dir, { url: "http://127.0.0.1:4096", password: "pw" }));
    expect(local).toEqual({ url: "http://127.0.0.1:4096", authorization: `Basic ${btoa("opencode:pw")}` });
    for (const url of ["http://example.com:4096", "https://127.0.0.1:4096", "http://10.0.0.2:4096"])
      expect(() => opencodeService(serviceFile(dir, { url, password: "pw" }))).toThrow();
    expect(() => opencodeService(serviceFile(dir, { url: "http://127.0.0.1:4096" }))).toThrow();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("sessions are read from the service over HTTP, with a pending permission as waiting", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("Authorization") !== `Basic ${btoa("opencode:pw")}`)
        return new Response("unauthorized", { status: 401 });
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const routes: Record<string, unknown> = {
        "/api/session/active": { data: { ses_a: { type: "running" } } },
        "/api/session": {
          data: [
            { id: "ses_a", title: "A", time: { created: 1, updated: 2 }, location: { directory: "/repo" } },
            { id: "ses_b", time: { created: 1, updated: 2, archived: 3 }, location: { directory: "/repo" } },
          ],
        },
        "/api/session/ses_a/permission": { data: [{ id: "per_1" }] },
        "/api/session/ses_a/form": { data: [] },
      };
      return url.pathname in routes ? Response.json(routes[url.pathname]) : new Response("missing", { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  const state = Bun.env.XDG_STATE_HOME;
  serviceFile(dir, { url: `http://127.0.0.1:${server.port}`, password: "pw" });
  Bun.env.XDG_STATE_HOME = dir;
  try {
    const listing = await opencodeSessions();
    expect(listing.live).toBe(true);
    expect(listing.sessions.map(({ id, activity, running }) => ({ id, activity, running }))).toEqual([
      { id: "ses_a", activity: "waiting", running: true },
    ]);
    expect(requests).toContain("GET /api/session?limit=100");
  } finally {
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
    server.stop(true);
    rmSync(dir, { recursive: true });
  }
});

test("a terminal session is told from a subcommand on argv, and only a valid id is read back", () => {
  const id = "ses_e67fb939cffebq6gr36R6Z5T16";
  expect(opencodeInvocation(["opencode"])).toEqual({ id: undefined, shared: true });
  expect(opencodeInvocation(["opencode", "/repo", "--session", id])).toEqual({ id, shared: true });
  expect(opencodeInvocation(["/usr/bin/opencode", `--session=${id}`])).toEqual({ id, shared: true });
  expect(opencodeInvocation(["opencode", "-s", id, "--standalone"])).toEqual({ id, shared: false });
  expect(opencodeInvocation(["opencode", "--server", "http://host:1"])?.shared).toBe(false);
  expect(opencodeInvocation(["opencode", "-s", "--flag"])?.id).toBeUndefined();
  expect(opencodeInvocation(["opencode", "mini"])).toBeDefined();
  // The value of a flag is not a subcommand, even when it reads like one.
  expect(opencodeInvocation(["opencode", "--prompt", "run"])).toBeDefined();
  for (const command of ["run", "serve", "api", "session", "acp"])
    expect(opencodeInvocation(["opencode", command])).toBeUndefined();
});

test("only the background service counts as the service", () => {
  expect(isOpencodeService(["/usr/bin/opencode", "serve", "--service"])).toBe(true);
  expect(isOpencodeService(["opencode", "serve"])).toBe(false);
  expect(isOpencodeService(["opencode"])).toBe(false);
});

test("a generated id is one discovery can read back", () => {
  const id = newOpencodeSessionId();
  expect(opencodeInvocation(["opencode", "--session", id])?.id).toBe(id);
  expect(newOpencodeSessionId()).not.toBe(id);
});

test("a prompt outranks a running turn, and states kiln does not know stay unknown", () => {
  expect(opencodeActivity({ type: "running" }, true)).toBe("waiting");
  expect(opencodeActivity({ type: "running" }, false)).toBe("working");
  expect(opencodeActivity({ type: "paused" }, false)).toBeUndefined();
  expect(opencodeActivity(undefined, false)).toBe("idle");
  expect(opencodeActivity(undefined, false, "succeeded")).toBe("idle");
  expect(opencodeActivity(undefined, false, "interrupted")).toBe("idle");
  expect(opencodeActivity(undefined, false, "failed")).toBe("waiting");
  expect(opencodeActivity(undefined, false, "cancelled")).toBeUndefined();
});

test("a closed conversation is history, unless it is still running and spending", () => {
  expect(opencodeShown(undefined, false)).toBe(true);
  expect(opencodeShown(undefined, true)).toBe(true);
  expect(opencodeShown(1_793_696_431_870, true)).toBe(true);
  expect(opencodeShown(1_793_696_431_870, false)).toBe(false);
});
