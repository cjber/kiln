import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { serveOptions, setupTailscale } from "./serve";

const unitName = "kiln-serve.service";
const usage = "usage: kiln setup [--port 7437] [--origin https://host]";

/** systemd splits on whitespace and expands `%` and `$`, so every argument is quoted and escaped. */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/**
 * The service serves localhost only: setup owns the tunnel and the invitation, so a restart
 * never writes a pairing code to the journal. `KillMode=process` leaves the ACP host and its
 * sessions running when the service stops.
 */
export function serveUnit(command: readonly string[], port: number, path: string): string {
  return `[Unit]
Description=kiln phone server
StartLimitIntervalSec=0

[Service]
Environment=${quote(`PATH=${path}`)}
ExecStart=${[...command, "serve", "--local", "--port", String(port)].map(quote).join(" ")}
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
`;
}

function kilnCommand(): string[] {
  return process.execPath.endsWith("bun") ? [process.execPath, join(import.meta.dir, "index.tsx")] : [process.execPath];
}

async function spawn(argv: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: (stdout || stderr).trim() };
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Install the user service and the tunnel, reporting each step; a repeated run changes nothing. */
export async function runSetup(
  args: readonly string[],
  {
    run = spawn,
    unitDirectory = join(Bun.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user"),
    command = kilnCommand(),
    path = Bun.env.PATH ?? "",
    isListening = listening,
    tunnel = setupTailscale,
    user = userInfo().username,
    report = (line: string) => console.log(`kiln: ${line}`),
  } = {},
): Promise<string> {
  const options = serveOptions(args, usage);
  if (options.local) throw new Error(usage);
  if (!Bun.which("systemctl"))
    throw new Error("kiln setup needs systemd user services; run kiln serve in a terminal instead");
  const systemctl = async (...rest: string[]) => {
    const result = await run(["systemctl", "--user", ...rest]);
    if (result.code) throw new Error(result.output || `systemctl --user ${rest.join(" ")} failed`);
  };

  const unitPath = join(unitDirectory, unitName);
  const unit = serveUnit(command, options.port, path);
  let existing: string | undefined;
  try {
    existing = readFileSync(unitPath, "utf8");
  } catch {
    // No unit yet.
  }
  const changed = existing !== unit;
  // A linked unit belongs to whoever manages its target, such as a dotfiles repository.
  if (changed && existing !== undefined && lstatSync(unitPath).isSymbolicLink())
    throw new Error(`${unitPath} is a symlink kiln did not create; remove it, then run kiln setup again`);
  const active = (await run(["systemctl", "--user", "is-active", "--quiet", unitName])).code === 0;
  if (!active && (await isListening(options.port)))
    throw new Error(`port ${options.port} is already in use; stop the running kiln serve, then run kiln setup again`);
  if (changed) {
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(unitPath, unit);
    await systemctl("daemon-reload");
    report(`${existing === undefined ? "installed" : "updated"} ${unitPath}`);
  } else report(`${unitPath} is up to date`);
  await systemctl("enable", unitName);
  if (active && changed) {
    await systemctl("restart", unitName);
    report("restarted the phone server");
  } else if (active) report("the phone server is already running");
  else {
    await systemctl("start", unitName);
    report("started the phone server; it now starts at login");
  }
  if ((await run(["loginctl", "show-user", user, "--property=Linger", "--value"])).output !== "yes")
    report(`to start it at boot, before you log in, run: loginctl enable-linger ${user}`);

  const origin = options.origin ?? (await tunnel(options.port));
  report(`phone access at ${origin}`);
  return origin;
}
