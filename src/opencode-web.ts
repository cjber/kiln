import { opencodeSessions } from "./opencode";
import { tailscale } from "./serve";

/** OpenCode's service is pinned to this port, and Tailscale serves its web UI on the same HTTPS port. */
export const opencodeWebPort = 4096;
const target = `http://127.0.0.1:${opencodeWebPort}`;

type Run = (argv: string[]) => Promise<{ code: number; output: string }>;
type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
};

/** The web UI keys each server by its URL, base64url encoded, in the session route. */
export function opencodeSessionLink(origin: string, id: string): string {
  return `${origin}/server/${Buffer.from(origin).toString("base64url")}/session/${id}`;
}

/** The tailnet origin whose root proxies to the pinned OpenCode service, if `kiln setup` created one. */
export function opencodeWebOrigin(config: ServeConfig): string | undefined {
  for (const [address, web] of Object.entries(config.Web ?? {}))
    if (address.endsWith(`:${opencodeWebPort}`) && web.Handlers?.["/"]?.Proxy === target) return `https://${address}`;
  return undefined;
}

let cache: { at: number; origin?: string } | undefined;

/** Read at most once a minute; setup is the only writer, and no Tailscale means no link. */
export async function servedOpencodeOrigin(now = Date.now(), execute = tailscale): Promise<string | undefined> {
  if (cache && now - cache.at < 60_000) return cache.origin;
  let origin: string | undefined;
  try {
    origin = opencodeWebOrigin(JSON.parse(await execute(["serve", "status", "--json"])));
  } catch {
    origin = undefined;
  }
  cache = { at: now, origin };
  return origin;
}

async function opencodeBusy(): Promise<boolean> {
  return (await opencodeSessions()).sessions.some((session) => session.running);
}

/**
 * Pin the service's port and serve its web UI on the tailnet next to kiln. Changing the port restarts the
 * service, so a service running a turn is left alone and setup says to run again.
 */
export async function setupOpencodeWeb(
  origin: string,
  {
    run,
    execute = tailscale,
    busy = opencodeBusy,
    installed = Bun.which("opencode") !== null,
  }: { run: Run; execute?: typeof tailscale; busy?: () => Promise<boolean>; installed?: boolean },
): Promise<{ origin?: string; note: string }> {
  if (!installed) return { note: "OpenCode is not installed, so its sessions open on the PC only" };
  const host = new URL(origin).hostname;
  const config: ServeConfig = JSON.parse(await execute(["serve", "status", "--json"]));
  const proxy = config.Web?.[`${host}:${opencodeWebPort}`]?.Handlers?.["/"]?.Proxy;
  const tcp = config.TCP?.[String(opencodeWebPort)];
  if ((tcp && tcp.HTTPS !== true) || (proxy && proxy !== target))
    return { note: `Tailscale port ${opencodeWebPort} already serves another service, so OpenCode stays on the PC` };

  const running = (await run(["opencode", "service", "status"])).output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
  if (running !== String(opencodeWebPort)) {
    if (running && (await busy()))
      return {
        note: "OpenCode is running a turn; run kiln setup again when it finishes to open its sessions on the phone",
      };
    const pinned = await run(["opencode", "service", "set", "port", String(opencodeWebPort)]);
    if (pinned.code) throw new Error(pinned.output || "OpenCode did not accept its service port");
    if (running) {
      const started = await run(["opencode", "service", "start"]);
      if (started.code) throw new Error(started.output || "OpenCode's service did not restart");
    }
  }
  await execute(["serve", "--bg", "--yes", `--https=${opencodeWebPort}`, target]);
  const served = `https://${host}:${opencodeWebPort}`;
  return { origin: served, note: `OpenCode sessions open at ${served}` };
}

/** A one-time link that signs a browser in to the service; scanning it once lets session links open directly. */
export async function opencodePairingLink(origin: string, run: Run): Promise<string> {
  const result = await run(["opencode", "pair", "--url", origin]);
  const link = result.output.match(/https:\/\/\S+\/auth\/connect\/[A-Za-z0-9_-]+/)?.[0];
  if (result.code || !link) throw new Error(result.output || "OpenCode did not print a pairing link");
  return link;
}
