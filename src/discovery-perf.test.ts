import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("slow process lookups leave the discovery event loop responsive", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kiln-discovery-perf-"));
  try {
    for (const name of ["claude", "tmux"])
      writeFileSync(join(scratch, name), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
    writeFileSync(join(scratch, "pgrep"), "#!/bin/sh\nsleep 0.25\nexit 1\n", { mode: 0o755 });
    const probe = join(scratch, "probe.ts");
    writeFileSync(
      probe,
      `
      import { listSessions } from ${JSON.stringify(join(import.meta.dir, "sessions.ts"))};
      let gap = 0;
      let previous = performance.now();
      const heartbeat = setInterval(() => {
        const now = performance.now();
        gap = Math.max(gap, now - previous);
        previous = now;
      }, 10);
      const start = performance.now();
      await listSessions({ kitty: false });
      await Bun.sleep(20);
      clearInterval(heartbeat);
      console.log(JSON.stringify({ gap, duration: performance.now() - start }));
    `,
    );
    const child = Bun.spawn([process.execPath, probe], {
      env: { ...Bun.env, PATH: `${scratch}:${Bun.env.PATH}`, CODEX_HOME: scratch, PI_CODING_AGENT_DIR: scratch },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(output);
    expect(result.duration).toBeGreaterThan(200);
    expect(result.gap).toBeLessThan(150);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
