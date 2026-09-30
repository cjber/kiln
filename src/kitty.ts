import { existsSync, readFileSync } from "node:fs";

type KittyWindow = { socket: string; id: number; pids: number[] };

type KittyLs = { tabs: { windows: { id: number; pid: number; foreground_processes: { pid: number }[] }[] }[] }[];

/**
 * Every running kitty's remote-control socket. `listen_on unix:@kitty` gives
 * each instance an abstract socket named after its pid, so a dead instance's
 * name is filtered out rather than timed out on.
 */
function sockets(): string[] {
  let table: string;
  try {
    table = readFileSync("/proc/net/unix", "utf8");
  } catch {
    return [];
  }
  const names = new Set(table.match(/@kitty-\d+/g) ?? []);
  return [...names].filter((name) => existsSync(`/proc/${name.slice("@kitty-".length)}`)).map((name) => `unix:${name}`);
}

async function windowsAt(socket: string): Promise<KittyWindow[]> {
  const process = Bun.spawn(["kitty", "@", "--to", socket, "ls"], { stdout: "pipe", stderr: "ignore", timeout: 2_000 });
  if (await process.exited) return [];
  try {
    const instances = JSON.parse(await new Response(process.stdout).text()) as KittyLs;
    return instances.flatMap((instance) => instance.tabs.flatMap((tab) => tab.windows.map((window) => ({
      socket,
      id: window.id,
      pids: [window.pid, ...window.foreground_processes.map((item) => item.pid)],
    }))));
  } catch {
    return [];
  }
}

export async function kittyWindows(): Promise<KittyWindow[]> {
  if (!Bun.which("kitty")) return [];
  return (await Promise.all(sockets().map(windowsAt))).flat();
}

export function focus(socket: string, windowId: number): boolean {
  return Bun.spawnSync(["kitty", "@", "--to", socket, "focus-window", "--match", `id:${windowId}`], { stderr: "pipe" }).exitCode === 0;
}
