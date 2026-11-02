import { randomBytes } from "node:crypto";
import { opencodeBusy } from "./opencode";
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

function portFree(): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port: opencodeWebPort, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
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
    free = portFree,
  }: { run: Run; execute?: typeof tailscale; busy?: () => Promise<boolean>; installed?: boolean; free?: () => boolean },
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
    // Moving the service onto a taken port would stop it and leave it unable to start.
    if (!free()) return { note: `Port ${opencodeWebPort} is in use on this PC, so OpenCode stays on the PC` };
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

/** A fresh OpenCode sign-in token, from a one-time pairing code redeemed on the local service. */
export async function opencodeToken(origin: string, run: Run): Promise<string> {
  const result = await run(["opencode", "pair", "--url", origin]);
  const code = result.output.match(/\/auth\/connect\/([A-Za-z0-9_-]+)/)?.[1];
  if (result.code || !code) throw new Error("OpenCode did not print a pairing link");
  const response = await fetch(`${target}/auth/connect/${code}`, { headers: { Accept: "application/json" } });
  const token = response.ok ? ((await response.json()) as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || !/^\d+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error("OpenCode did not accept its own pairing code");
  return token;
}

const linkLifetime = 15 * 60_000;

/**
 * One-use kiln paths that sign the phone's browser in to OpenCode and land on a session. Each session keeps the
 * same path until it is used or half its lifetime has passed, so snapshots do not change on every refresh.
 */
export function opencodeLinks(signIn: (origin: string) => Promise<string>) {
  const links = new Map<string, { session: string; at: number }>();
  const current = new Map<string, string>();
  return {
    path(session: string, now = Date.now()): string {
      for (const [code, link] of links) if (now - link.at >= linkLifetime) links.delete(code);
      const code = current.get(session);
      const link = code ? links.get(code) : undefined;
      if (code && link && now - link.at < linkLifetime / 2) return `/opencode/${code}`;
      const fresh = randomBytes(24).toString("base64url");
      links.set(fresh, { session, at: now });
      current.set(session, fresh);
      return `/opencode/${fresh}`;
    },
    /**
     * Browsers scope cookies by host, not port, so the cookie set here on kiln's address reaches OpenCode's.
     * It is the one OpenCode sets itself when a browser opens a pairing link.
     */
    async open(code: string, origin: string | undefined, now = Date.now()): Promise<Response> {
      const link = links.get(code);
      links.delete(code);
      if (!link || now - link.at >= linkLifetime)
        return text("This link has been used or has expired. Tap Open in OpenCode in kiln again.\n", 404);
      if (!origin) return text("OpenCode's web UI is not set up on this computer. Run kiln setup.\n", 503);
      let token: string;
      try {
        token = await signIn(origin);
      } catch {
        return text("OpenCode's service did not sign this browser in. Check that it is running.\n", 502);
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: opencodeSessionLink(origin, link.session),
          "Set-Cookie": `opencode_session_${opencodeWebPort}=${token}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    },
  };
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
