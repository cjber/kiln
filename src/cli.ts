import packageJson from "../package.json";
import { listSessions, summarise } from "./sessions";
import { loadSettings } from "./settings";

const usage = `usage: kiln            open the session list
       kiln status     print session counts (used by the in-session status bar)
       kiln serve [--port 7437]    serve the phone list on localhost
       kiln pair <https-origin> [--qr]   print a five-minute phone invitation
       kiln devices               list paired phones
       kiln revoke <device-id>    revoke a phone
       kiln --version`;

/** Anything but the bare TUI is handled here; an unknown argument is an error, never a silent TUI launch. */
export async function runCli(args: string[]): Promise<number | undefined> {
  const [command] = args;
  if (command === undefined) return undefined;
  if (["serve", "pair", "devices", "revoke"].includes(command)) {
    try {
      const { Pairing, serverOrigin } = await import("./pairing");
      if (command === "serve") {
        if (args.length !== 1 && (args.length !== 3 || args[1] !== "--port" || !/^\d+$/.test(args[2] ?? "")))
          throw new Error("usage: kiln serve [--port 7437]");
        const port = args[2] ? Number(args[2]) : 7437;
        if (port < 1 || port > 65535) throw new Error("port must be between 1 and 65535");
        loadSettings();
        const { startServer } = await import("./server");
        const pairing = new Pairing();
        const server = startServer({ port, pairing });
        console.log(`kiln: listening on http://127.0.0.1:${server.port}; expose through Tailscale Serve`);
        const stop = () => {
          server.stop();
          pairing.close();
          process.exit(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await new Promise(() => {});
      }
      if (
        (command === "pair" && args.length !== 2 && (args.length !== 3 || args[2] !== "--qr")) ||
        (command === "devices" && args.length !== 1) ||
        (command === "revoke" && args.length !== 2)
      )
        throw new Error(usage);
      const pairing = new Pairing();
      try {
        switch (command) {
          case "pair": {
            const origin = serverOrigin(args[1] ?? "");
            const invitation = new URL("kiln://pair");
            invitation.searchParams.set("server", origin);
            invitation.searchParams.set("code", pairing.invite());
            console.log(invitation.href);
            if (args[2] === "--qr") {
              const { default: QRCode } = await import("qrcode");
              console.log(await QRCode.toString(invitation.href, { type: "terminal", small: true }));
            }
            console.log("Paste this invitation into kiln on the phone. It expires in five minutes and works once.");
            return 0;
          }
          case "devices":
            for (const device of pairing.devices()) console.log(`${device.id}  ${device.name}`);
            return 0;
          case "revoke":
            if (!pairing.revoke(args[1] ?? "")) throw new Error("paired device not found");
            console.log("Device revoked");
            return 0;
        }
      } finally {
        pairing.close();
      }
    } catch (error) {
      console.error(`kiln: ${error instanceof Error ? error.message : "server command failed"}`);
      return 2;
    }
  }
  if (command === "--version" || command === "-V") {
    console.log(`kiln ${packageJson.version}`);
    return 0;
  }
  if (command === "status") {
    console.log(summarise(await listSessions({ kitty: false })));
    return 0;
  }
  if (command === "--help" || command === "-h") {
    console.log(usage);
    return 0;
  }
  console.error(`kiln: unknown argument "${command}"\n${usage}`);
  return 2;
}
