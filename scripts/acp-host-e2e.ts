import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acpRequest, ensureAcpHost } from "../src/acp-host";

const root = mkdtempSync("/tmp/kiln-host-recovery-");
Bun.env.KILN_ACP_SOCKET = join(root, "host.sock");
Bun.env.XDG_CONFIG_HOME = root;
mkdirSync(join(root, "kiln"));
writeFileSync(
  join(root, "kiln/config.toml"),
  `cloud = false\nnotifications = false\n[agents]\ncodex = ["${process.execPath}", "${join(import.meta.dir, "acp-fixture.ts")}", "11000"]\n`,
);
let pid: number | undefined;
try {
  await Promise.all([ensureAcpHost(), ensureAcpHost()]);
  pid = (await acpRequest<{ pid: number }>("/health")).pid;
  const session = await acpRequest<{ id: string }>("/sessions", { agent: "codex", cwd: root });
  await Bun.sleep(100);
  process.kill(pid, "SIGKILL");
  await Bun.sleep(300);
  await ensureAcpHost();
  const next = (await acpRequest<{ pid: number }>("/health")).pid;
  if (next === pid) throw Error("Host did not restart");
  pid = next;
  let restored = false;
  for (let i = 0; i < 100; i++) {
    const rows = await acpRequest<{ id: string; activity: string }[]>("/sessions");
    if (rows.length === 1 && rows[0]?.id === session.id && rows[0]?.activity === "idle") {
      restored = true;
      break;
    }
    await Bun.sleep(50);
  }
  if (!restored) throw Error("Saved conversation did not restore");
  console.log("Slow adapter startup, concurrent host startup and crash recovery passed");
} finally {
  if (pid)
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  await Bun.sleep(100);
  rmSync(root, { recursive: true, force: true });
}
