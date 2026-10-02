import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, serveUnit } from "./setup";

test("the unit serves localhost only and escapes systemd specifiers", () => {
  const unit = serveUnit(["/opt/my kiln/kiln"], 7437, "/usr/bin:/home/a%b/$bin");
  expect(unit).toContain('ExecStart="/opt/my kiln/kiln" "serve" "--local" "--port" "7437"');
  expect(unit).toContain('Environment="PATH=/usr/bin:/home/a%%b/$$bin"');
});

test("setup installs and starts the service once, then changes nothing", async () => {
  const unitDirectory = mkdtempSync(join(tmpdir(), "kiln-setup-"));
  const calls: string[] = [];
  const reports: string[] = [];
  let active = false;
  let busy = false;
  const dependencies = {
    unitDirectory,
    command: ["/usr/bin/kiln"],
    path: "/usr/bin",
    user: "demo",
    isListening: async () => busy,
    tunnel: async (port: number) => `https://machine.example:${port}`,
    report: (line: string) => reports.push(line),
    run: async (argv: string[]) => {
      calls.push(argv.slice(2).join(" "));
      if (argv.includes("is-active")) return { code: active ? 0 : 3, output: "" };
      if (argv.includes("start")) active = true;
      return { code: 0, output: argv[0] === "loginctl" ? "no" : "" };
    },
  };
  try {
    busy = true;
    await expect(runSetup([], dependencies)).rejects.toThrow("already in use");
    expect(calls).toEqual(["is-active --quiet kiln-serve.service"]);
    busy = false;
    expect(await runSetup(["--port", "8000"], dependencies)).toBe("https://machine.example:8000");
    expect(readFileSync(join(unitDirectory, "kiln-serve.service"), "utf8")).toContain('"--port" "8000"');
    expect(calls).toContain("daemon-reload");
    expect(calls).toContain("start kiln-serve.service");
    expect(reports.some((line) => line.includes("loginctl enable-linger demo"))).toBe(true);

    calls.length = 0;
    reports.length = 0;
    expect(await runSetup(["--port", "8000", "--origin", "https://own.example"], dependencies)).toBe(
      "https://own.example",
    );
    expect(calls.some((call) => /daemon-reload|^start|^restart/.test(call))).toBe(false);
    expect(reports[0]).toEndWith("is up to date");

    calls.length = 0;
    await runSetup([], dependencies);
    expect(calls).toContain("restart kiln-serve.service");
    await expect(runSetup(["--local"], dependencies)).rejects.toThrow("usage: kiln setup");

    const managed = join(unitDirectory, "managed.service");
    writeFileSync(managed, "[Service]\nExecStart=/usr/bin/kiln serve\n");
    rmSync(join(unitDirectory, "kiln-serve.service"));
    symlinkSync(managed, join(unitDirectory, "kiln-serve.service"));
    await expect(runSetup([], dependencies)).rejects.toThrow("is a symlink");
    expect(readFileSync(managed, "utf8")).toContain("ExecStart=/usr/bin/kiln serve\n");
    rmSync(managed);
    await expect(runSetup([], dependencies)).rejects.toThrow("is a symlink");
    expect(existsSync(managed)).toBe(false);
  } finally {
    rmSync(unitDirectory, { recursive: true, force: true });
  }
});
