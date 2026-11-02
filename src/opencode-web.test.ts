import { expect, test } from "bun:test";
import { opencodePairingLink, opencodeSessionLink, opencodeWebOrigin, setupOpencodeWeb } from "./opencode-web";

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

test("the pairing link is read from OpenCode's output", async () => {
  const output = "Open a link to connect.\n\n  https://machine.example.ts.net:4096/auth/connect/abc_DEF-1\n";
  expect(await opencodePairingLink("https://machine.example.ts.net:4096", async () => ({ code: 0, output }))).toBe(
    "https://machine.example.ts.net:4096/auth/connect/abc_DEF-1",
  );
  await expect(opencodePairingLink(origin, async () => ({ code: 1, output: "no service" }))).rejects.toThrow(
    "no service",
  );
});
