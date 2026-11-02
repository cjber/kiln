import { expect, test } from "bun:test";
import { opencodeLinks, opencodeSessionLink, opencodeWebOrigin, setupOpencodeWeb } from "./opencode-web";

const origin = "https://machine.example.ts.net";
const served = { Web: { "machine.example.ts.net:4096": { Handlers: { "/": { Proxy: "http://127.0.0.1:4096" } } } } };

test("a session link carries the server key the web UI routes by", () => {
  expect(opencodeSessionLink("https://machine.example.ts.net:4096", "ses_abc")).toBe(
    "https://machine.example.ts.net:4096/server/aHR0cHM6Ly9tYWNoaW5lLmV4YW1wbGUudHMubmV0OjQwOTY/session/ses_abc",
  );
});

test("only a root proxy to the pinned service counts as OpenCode's web UI", () => {
  expect(opencodeWebOrigin(served)).toBe("https://machine.example.ts.net:4096");
  expect(opencodeWebOrigin({ Web: { "machine.example.ts.net:443": served.Web["machine.example.ts.net:4096"] } })).toBe(
    undefined,
  );
  expect(
    opencodeWebOrigin({
      Web: { "machine.example.ts.net:4096": { Handlers: { "/": { Proxy: "http://127.0.0.1:9" } } } },
    }),
  ).toBeUndefined();
  expect(opencodeWebOrigin({})).toBeUndefined();
});

function harness({
  port,
  busy = false,
  free = true,
  config = {},
}: {
  port?: number;
  busy?: boolean;
  free?: boolean;
  config?: object;
}) {
  const calls: string[] = [];
  return {
    calls,
    options: {
      installed: true,
      free: () => free,
      busy: async () => busy,
      execute: async (args: string[]) => {
        calls.push(`tailscale ${args.join(" ")}`);
        return args[0] === "serve" && args[1] === "status" ? JSON.stringify(config) : "";
      },
      run: async (argv: string[]) => {
        calls.push(argv.join(" "));
        return { code: 0, output: argv[2] === "status" && port ? `http://127.0.0.1:${port}` : "" };
      },
    },
  };
}

test("setup pins an idle service's port, then serves its web UI on the tailnet", async () => {
  const { calls, options } = harness({ port: 49374 });
  expect(await setupOpencodeWeb(origin, options)).toMatchObject({ origin: "https://machine.example.ts.net:4096" });
  expect(calls).toContain("opencode service set port 4096");
  expect(calls).toContain("opencode service start");
  expect(calls).toContain("tailscale serve --bg --yes --https=4096 http://127.0.0.1:4096");
});

test("setup changes nothing on a service that already runs on the pinned port", async () => {
  const { calls, options } = harness({ port: 4096, config: served });
  expect((await setupOpencodeWeb(origin, options)).origin).toBe("https://machine.example.ts.net:4096");
  expect(calls.some((call) => call.includes("service set") || call.includes("service start"))).toBe(false);
});

test("setup leaves a service running a turn, and a port something else holds", async () => {
  const busy = harness({ port: 49374, busy: true });
  expect(await setupOpencodeWeb(origin, busy.options)).toEqual({
    note: "OpenCode is running a turn; run kiln setup again when it finishes to open its sessions on the phone",
  });
  expect(busy.calls.some((call) => call.includes("service set") || call.includes("--https"))).toBe(false);

  const occupied = harness({ port: 49374, free: false });
  expect((await setupOpencodeWeb(origin, occupied.options)).origin).toBeUndefined();
  expect(occupied.calls.some((call) => call.includes("service set"))).toBe(false);

  const taken = harness({
    port: 4096,
    config: { Web: { "machine.example.ts.net:4096": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } },
  });
  expect((await setupOpencodeWeb(origin, taken.options)).origin).toBeUndefined();
  expect(taken.calls.some((call) => call.includes("--https"))).toBe(false);
});

test("setup without OpenCode installed touches nothing", async () => {
  const { calls, options } = harness({ port: 4096 });
  expect((await setupOpencodeWeb(origin, { ...options, installed: false })).origin).toBeUndefined();
  expect(calls).toEqual([]);
});

test("a sign-in link is used once, sets OpenCode's cookie and lands on the session", async () => {
  const served = "https://machine.example.ts.net:4096";
  const links = opencodeLinks(async () => "1796211887.signed");
  const path = links.path("ses_abc", 0);
  expect(links.path("ses_abc", 1_000)).toBe(path);
  const code = path.replace("/opencode/", "");
  expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);

  const opened = await links.open(code, served, 2_000);
  expect(opened.status).toBe(302);
  expect(opened.headers.get("Location")).toBe(opencodeSessionLink(served, "ses_abc"));
  expect(opened.headers.get("Set-Cookie")).toStartWith("opencode_session_4096=1796211887.signed; Max-Age=2592000;");
  expect((await links.open(code, served, 3_000)).status).toBe(404);
  expect(links.path("ses_abc", 4_000)).not.toBe(path);
});

test("a sign-in link ages out, and needs OpenCode served and answering", async () => {
  const links = opencodeLinks(async () => {
    throw new Error("service down");
  });
  const code = (path: string) => path.replace("/opencode/", "");
  expect((await links.open(code(links.path("ses_a", 0)), origin, 15 * 60_000)).status).toBe(404);
  expect((await links.open(code(links.path("ses_b", 0)), undefined, 0)).status).toBe(503);
  expect((await links.open(code(links.path("ses_c", 0)), origin, 0)).status).toBe(502);
});
