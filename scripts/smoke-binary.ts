import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = process.argv[2];
if (!source) throw new Error("usage: bun scripts/smoke-binary.ts <binary>");
const tmux = Bun.which("tmux");
if (!tmux) throw new Error("binary smoke test needs tmux");
const scratch = mkdtempSync(join(tmpdir(), "kiln-binary-"));
const executable = join(scratch, "installed kiln");
const outer = `kiln-smoke-outer-${process.pid}`;
const inner = `kiln-smoke-inner-${process.pid}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const { TMUX: _outer, ...inherited } = Bun.env;
const env = {
  ...inherited,
  HOME: scratch,
  XDG_CONFIG_HOME: join(scratch, ".config"),
  CLAUDE_CONFIG_DIR: join(scratch, ".claude"),
  CODEX_HOME: join(scratch, ".codex"),
  PATH: `${join(scratch, "bin")}:${Bun.env.PATH}`,
};

function run(argv: string[]): string {
  const result = Bun.spawnSync(argv, { env, cwd: scratch, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`${argv[0]} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

async function waitFor(read: () => string, contains: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  let last = "";
  do {
    try {
      last = read();
    } catch (error) {
      last = String(error);
    }
    if (last.includes(contains)) return last;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${contains}: ${last}`);
}

try {
  copyFileSync(resolve(source), executable);
  chmodSync(executable, 0o755);
  mkdirSync(join(scratch, "bin"));
  mkdirSync(join(env.XDG_CONFIG_HOME, "kiln"), { recursive: true });
  writeFileSync(
    join(env.XDG_CONFIG_HOME, "kiln", "config.toml"),
    `remote_control = false\ncloud = false\nzoxide = false\n[agents]\nclaude = ["sh", "-c", "sleep 60"]\ncodex = []\npi = []\n`,
  );
  writeFileSync(
    join(scratch, "bin", "tmux"),
    `#!/bin/sh\nif [ "$1" = -L ] && [ "$2" = kiln ]; then\n  shift 2\n  exec ${quote(tmux)} -L ${quote(inner)} "$@"\nfi\nexec ${quote(tmux)} "$@"\n`,
    { mode: 0o755 },
  );
  // The directory picker returns a fixture path; the agent is sleep, so no provider is contacted.
  writeFileSync(join(scratch, "bin", "fzf"), `#!/bin/sh\nprintf '%s\\n' ${quote(scratch)}\n`, { mode: 0o755 });
  if (!run([executable, "--version"]).startsWith("kiln ")) throw new Error("binary version failed");
  run([executable, "status"]);
  run([executable, "skills", "sync"]);
  const installedSkills = JSON.parse(run([executable, "skills", "list"])).skills;
  for (const name of ["kiln-config", "kiln-skills"]) {
    const skill = installedSkills.find((entry: { name: string }) => entry.name === name);
    if (skill?.claude !== "shared" || skill.pi !== "shared")
      throw new Error(`bundled ${name} was not installed and shared`);
    if (!readFileSync(join(skill.directory, "SKILL.md"), "utf8").includes(`name: ${name}`))
      throw new Error(`bundled ${name} instructions are missing`);
  }
  run([
    tmux,
    "-L",
    outer,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "list",
    "-x",
    "120",
    "-y",
    "28",
    `exec ${quote(executable)}`,
  ]);
  const capture = () => run([tmux, "-L", outer, "capture-pane", "-p", "-t", "list"]);
  await waitFor(capture, "q quit");
  run([tmux, "-L", outer, "send-keys", "-t", "list", "n"]);
  await waitFor(capture, "pick a directory");
  run([tmux, "-L", outer, "send-keys", "-t", "list", "Enter"]);
  await waitFor(() => run([tmux, "-L", inner, "list-sessions", "-F", "#{session_name}"]), "claude-");
  const status = await waitFor(() => run([tmux, "-L", inner, "show-option", "-gv", "status-right"]), executable);
  if (!status.includes("status")) throw new Error("status bar does not invoke the installed binary");
  if (run([tmux, "-L", inner, "show-option", "-gv", "prefix"]).trim() !== "None")
    throw new Error("embedded tmux configuration was not applied");
  await waitFor(() => run([tmux, "-L", inner, "list-keys", "-T", "root"]), "detach-client");
  const client = (await waitFor(() => run([tmux, "-L", inner, "list-clients", "-F", "#{client_tty}"]), "/")).trim();
  run([tmux, "-L", inner, "detach-client", "-t", client]);
  await waitFor(capture, "q quit");
  run([tmux, "-L", outer, "send-keys", "-t", "list", "q"]);
  console.log(
    "binary version, status, bundled skills, native TUI, embedded tmux configuration, status executable and detach passed",
  );
} finally {
  for (const server of [outer, inner])
    Bun.spawnSync([tmux, "-L", server, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  rmSync(scratch, { recursive: true, force: true });
}
