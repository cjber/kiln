import packageJson from "../package.json";
import { listSessions, summarise } from "./sessions";
import { loadSettings } from "./settings";

const usage = `usage: kiln            open the session list
       kiln status     print session counts (used by the in-session status bar)
       kiln serve [--port 7437] [--origin https://host | --local]
                                  start phone access and print a pairing QR
       kiln setup [--port 7437] [--origin https://host]
                                  keep phone access running as a user service and print a pairing QR
       kiln pair <https-origin> [--qr]   print a five-minute phone invitation
       kiln devices               list paired phones
       kiln revoke <device-id>    revoke a phone
       kiln skills list|share|sync    manage shared skills
       kiln --version`;

/** Anything but the bare TUI is handled here; an unknown argument is an error, never a silent TUI launch. */
export async function runCli(args: string[]): Promise<number | undefined> {
  const [command] = args;
  if (command === undefined) return undefined;
  if (command === "acp-host") {
    const { ensureAcpHost, startAcpHost } = await import("./acp-host");
    if (args.length === 1) {
      await ensureAcpHost();
      return 0;
    }
    if (args.length !== 2 || args[1] !== "--locked") throw new Error("Invalid ACP host invocation");
    const host = startAcpHost({ locked: true });
    const stop = () => {
      host.stop();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => {});
  }
  if (command === "skills") {
    try {
      const { runSkillsCli } = await import("./skills-cli");
      runSkillsCli(args.slice(1));
      return 0;
    } catch (error) {
      console.error(`kiln: ${error instanceof Error ? error.message : "skills command failed"}`);
      return 2;
    }
  }
  if (["serve", "setup", "pair", "devices", "revoke"].includes(command)) {
    try {
      const { Pairing, serverOrigin } = await import("./pairing");
      if (command === "serve") {
        const { serveOptions, setupTailscale, printInvitation } = await import("./serve");
        const options = serveOptions(args.slice(1));
        loadSettings();
        const { ensureAcpHost } = await import("./acp-host");
        await ensureAcpHost();
        const { startServer } = await import("./server");
        const pairing = new Pairing();
        let server: ReturnType<typeof startServer> | undefined;
        try {
          server = startServer({ port: options.port, pairing });
          console.log(`kiln: listening on http://127.0.0.1:${server.port}`);
          if (!options.local) {
            const origin = options.origin ?? (await setupTailscale(server.port ?? options.port));
            console.log(`kiln: phone access at ${origin}`);
            await printInvitation(pairing, origin);
          }
        } catch (error) {
          server?.stop();
          pairing.close();
          throw error;
        }
        const stop = () => {
          server.stop();
          pairing.close();
          process.exit(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await new Promise(() => {});
      }
      if (command === "setup") {
        loadSettings();
        const { runSetup } = await import("./setup");
        const origin = await runSetup(args.slice(1));
        const { printInvitation } = await import("./serve");
        const pairing = new Pairing();
        try {
          await printInvitation(pairing, origin);
        } finally {
          pairing.close();
        }
        return 0;
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
            const { printInvitation } = await import("./serve");
            await printInvitation(pairing, origin, args[2] === "--qr");
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
    const { ensureAcpHost } = await import("./acp-host");
    await ensureAcpHost();
    // The counts need no terminal ownership, and tmux asks every few seconds.
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
