import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, serveUnit } from "./setup";

test("the unit serves its tunnel's origin and escapes systemd specifiers", () => {
  const unit = serveUnit(["/opt/my kiln/kiln"], 7437, "/usr/bin:/home/a%b/$bin", "https://machine.example");
  expect(unit).toContain('ExecStart="/opt/my kiln/kiln" "serve" "--origin" "https://machine.example" "--port" "7437"');
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
    named: async () => "https://machine.example",
    tunnel: async (port: number) => {
      calls.push(`tunnel ${port}`);
      return "https://machine.example";
    },
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
    expect(await runSetup(["--port", "8000"], dependencies)).toBe("https://machine.example");
    expect(readFileSync(join(unitDirectory, "kiln-serve.service"), "utf8")).toContain('"--port" "8000"');
    expect(calls).toContain("daemon-reload");
    // The tunnel points at the port only once the service holds it.
    expect(calls.indexOf("tunnel 8000")).toBeGreaterThan(calls.indexOf("start kiln-serve.service"));
    expect(reports.some((line) => line.includes("loginctl enable-linger demo"))).toBe(true);

    calls.length = 0;
    reports.length = 0;
    // Naming the origin the tunnel already has leaves the unit as it is, and a named origin brings its own tunnel.
    expect(await runSetup(["--port", "8000", "--origin", "https://machine.example"], dependencies)).toBe(
      "https://machine.example",
    );
    expect(calls.some((call) => /daemon-reload|^start|^restart|^tunnel/.test(call))).toBe(false);
    expect(reports[0]).toEndWith("is up to date");

    calls.length = 0;
    await runSetup([], dependencies);
    expect(calls).toContain("restart kiln-serve.service");
    await expect(runSetup(["--local"], dependencies)).rejects.toThrow("usage: kiln setup");

    const managed = join(unitDirectory, "managed.service");
    writeFileSync(managed, "[Service]\nExecStart=/usr/bin/kiln serve\n");
    rmSync(join(unitDirectory, "kiln-serve.service"));
    symlinkSync(managed, join(unitDirectory, "kiln-serve.service"));
    await expect(runSetup([], dependencies)).resolves.toBe("https://machine.example");
    expect(reports.some((line) => line.includes("links to a unit kiln does not manage"))).toBe(true);
    expect(readFileSync(managed, "utf8")).toBe("[Service]\nExecStart=/usr/bin/kiln serve\n");
    rmSync(managed);
    await expect(runSetup([], dependencies)).rejects.toThrow("links to a missing file");
    expect(existsSync(managed)).toBe(false);
  } finally {
    rmSync(unitDirectory, { recursive: true, force: true });
  }
});
