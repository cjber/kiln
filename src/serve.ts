import { type Pairing, serverOrigin } from "./pairing";

export function serveOptions(
  args: readonly string[],
  usage = "usage: kiln serve [--port 7437] [--origin https://host | --local]",
) {
  let port = 7437;
  let origin: string | undefined;
  let local = false;
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case "--port": {
        const value = args[++index] ?? "";
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
          throw new Error("port must be between 1 and 65535");
        port = Number(value);
        break;
      }
      case "--origin":
        origin = serverOrigin(args[++index] ?? "");
        break;
      case "--local":
        local = true;
        break;
      default:
        throw new Error(usage);
    }
  }
  if (local && origin) throw new Error("--local and --origin cannot be combined");
  return { port, origin, local };
}

async function tailscale(args: string[]): Promise<string> {
  if (!Bun.which("tailscale"))
    throw new Error(
      "Install and sign in to Tailscale, or use kiln serve --origin https://host with your own tunnel; --local serves localhost only",
    );
  const child = Bun.spawn(["tailscale", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [output, problem, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(problem.trim() || "Tailscale Serve did not start");
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** Keep other services intact; only claim an unused HTTPS root or kiln's existing proxy. */
export async function setupTailscale(port: number, execute = tailscale): Promise<string> {
  const status = JSON.parse(await execute(["status", "--json"]));
  if (status.BackendState !== "Running" || typeof status.Self?.DNSName !== "string")
    throw new Error("Tailscale is not connected; run tailscale up, or use kiln serve --origin https://host");
  const origin = serverOrigin(`https://${status.Self.DNSName.replace(/\.$/, "")}`);
  const config = JSON.parse(await execute(["serve", "status", "--json"]));
  const address = `${new URL(origin).hostname}:443`;
  const handlers = config.Web?.[address]?.Handlers;
  const target = `http://127.0.0.1:${port}`;
  if (config.TCP?.["443"] && config.TCP["443"].HTTPS !== true)
    throw new Error("Tailscale port 443 already serves another service; use --origin with a separate tunnel");
  if (handlers?.["/"] && handlers["/"].Proxy !== target)
    throw new Error("Tailscale HTTPS root already serves another service; use --origin with a separate tunnel");
  await execute(["serve", "--bg", "--yes", target]);
  return origin;
}

export async function printInvitation(pairing: Pairing, origin: string, qr = true): Promise<void> {
  const invitation = new URL("kiln://pair");
  invitation.searchParams.set("server", serverOrigin(origin));
  invitation.searchParams.set("code", pairing.invite());
  console.log(invitation.href);
  if (qr) {
    const { default: QRCode } = await import("qrcode");
    console.log(await QRCode.toString(invitation.href, { type: "terminal", small: true }));
  }
  console.log(
    "Scan this QR code or paste the invitation into kiln on your phone. It expires in five minutes and works once.",
  );
}
