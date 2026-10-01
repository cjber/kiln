import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "kiln-acp-e2e-"));
const config = join(scratch, "config");
mkdirSync(join(config, "kiln"), { recursive: true });
const command = [process.execPath, resolve("scripts/acp-fixture.ts")];
writeFileSync(
  join(config, "kiln", "config.toml"),
  `cloud = false\nnotifications = false\n[agents]\npi = ${JSON.stringify(command)}\n`,
);
const name = `kiln-acp-e2e-${process.pid}`;
const output = resolve(Bun.env.KILN_E2E_OUTPUT ?? join(tmpdir(), "kiln-tui-e2e-evidence"));
mkdirSync(output, { recursive: true });
async function drive(...args: string[]) {
  const child = Bun.spawn(["bunx", "tuistory@0.11.0", "-s", name, ...args], {
    env: { ...Bun.env, TUISTORY_PORT: "19474" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${args.join(" ")}: ${error || text}`);
  return text;
}
try {
  await drive(
    "--cols",
    "100",
    "--rows",
    "22",
    "--env",
    `XDG_CONFIG_HOME=${config}`,
    "--env",
    `KILN_ACP_SOCKET=${join(scratch, "host.sock")}`,
    "--",
    "bun",
    "scripts/acp-tui-fixture.tsx",
  );
  await drive("wait", "needs input", "--timeout", "15000");
  assert.ok((await drive("snapshot", "--fg", "#e5c46b")).includes("approve this"));
  await drive("press", "enter");
  await drive("wait", "Needs input: Read project files");
  await drive("screenshot", "-o", join(output, "acp-approval.png"));
  await drive("press", "enter");
  await drive("wait", "Permission answered.");
  await drive("wait", "Ready");
  await drive("type", "a second prompt");
  await drive("press", "enter");
  await drive("wait", "Checking the request.");
  await drive("press", "esc");
  await drive("wait", "ready");
  await drive("press", "enter");
  await drive("wait", "a second prompt");
  await drive("resize", "52", "12");
  await drive("wait", "esc list");
  await drive("screenshot", "-o", join(output, "acp-conversation.png"));
  await drive("press", "esc");
  await drive("press", "x");
  await drive("wait", "close");
  await drive("press", "y");
  await drive("wait", "closed pi");
  await drive("press", "q");
  console.log(`ACP PTY E2E passed; screenshots: ${output}`);
} catch (error) {
  await drive("screenshot", "-o", join(output, "acp-failure.png")).catch(() => {});
  throw error;
} finally {
  await drive("close").catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}
