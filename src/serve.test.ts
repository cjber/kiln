import { expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveOptions, setupTailscale, watchExecutable } from "./serve";

test("serve validates options before configuring a tunnel", () => {
  expect(serveOptions(["--port", "8000", "--origin", "https://phone.example/"])).toEqual({
    port: 8000,
    origin: "https://phone.example",
    local: false,
  });
  for (const args of [
    ["--port", "0"],
    ["--port", "8000oops"],
    ["--origin", "http://phone.example"],
    ["--local", "--origin", "https://phone.example"],
    ["--unknown"],
  ])
    expect(() => serveOptions(args)).toThrow();
});

test("one-command serving preserves other Tailscale services and rejects disconnected accounts", async () => {
  const calls: string[][] = [];
  let running = true;
  let config: object = {
    Web: { "machine.tail.example:443": { Handlers: { "/other": { Proxy: "http://127.0.0.1:8001" } } } },
  };
  const execute = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "status")
      return JSON.stringify({
        BackendState: running ? "Running" : "NeedsLogin",
        Self: { DNSName: "machine.tail.example." },
      });
    if (args[1] === "status") return JSON.stringify(config);
    return "";
  };
  expect(await setupTailscale(7437, execute)).toBe("https://machine.tail.example");
  expect(calls.at(-1)).toEqual(["serve", "--bg", "--yes", "http://127.0.0.1:7437"]);
  config = { Web: { "machine.tail.example:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } } };
  calls.length = 0;
  await expect(setupTailscale(7437, execute)).rejects.toThrow("another service");
  expect(calls).toHaveLength(2);
  running = false;
  calls.length = 0;
  await expect(setupTailscale(7437, execute)).rejects.toThrow("not connected");
  expect(calls).toHaveLength(1);
});

test("a replaced executable is noticed once, and an unchanged one never", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-serve-"));
  try {
    const path = join(root, "kiln");
    writeFileSync(path, "old");
    let replaced = 0;
    const stop = watchExecutable(() => replaced++, path, 5);
    await Bun.sleep(30);
    expect(replaced).toBe(0);
    writeFileSync(join(root, "kiln.new"), "new");
    renameSync(join(root, "kiln.new"), path);
    await Bun.sleep(30);
    expect(replaced).toBe(1);
    stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
