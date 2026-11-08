import packageJson from "../package.json";
import { listSessions, summarise } from "./sessions";
import { loadSettings } from "./settings";
import { cachedStatus } from "./status-cache";

const usage = `usage: kiln            open the session list
       kiln status     print session counts (used by the in-session status bar)
       kiln resume <name...|--all> [--prompt TEXT]
                                  resume sessions a restart stopped, one at a time; no names lists them
       kiln close [name...]       close, archive or forget sessions as x does in the list; no names lists them
       kiln serve [--port 7437] [--origin https://host | --local]
                                  start phone access; --local skips tunnel setup and the invitation
       kiln setup [--port 7437] [--origin https://host]
                                  keep phone access running as a user service and print a pairing QR
       kiln pair [https-origin]          print a five-minute phone invitation; the origin defaults to your Tailscale HTTPS name
       kiln devices               list paired phones
       kiln revoke <device-id>    revoke a phone
       kiln dashboard [--port 7438] [--open]
                                  serve a live progress page of every session on 127.0.0.1
       kiln skills list|share|sync    manage shared skills
       kiln msg list|send|inbox|whoami|spawn    let running agents message and start each other
       kiln msg spawn <agent> [--dir PATH] [--title T] -- <prompt>
                                   start a headless child under this session, in kiln's tmux
       agents: npx skills add cjber/kiln installs the kiln-config, kiln-skills and kiln-agents skills
       kiln --version`;

/** Anything but the bare TUI is handled here; an unknown argument is an error, never a silent TUI launch. */
export async function runCli(args: string[]): Promise<number | undefined> {
  const [command] = args;
  if (command === undefined) return undefined;
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
  if (command === "msg") {
    try {
      const { runMsgCli } = await import("./msg-cli");
      await runMsgCli(args.slice(1));
      return 0;
    } catch (error) {
      console.error(`kiln: ${error instanceof Error ? error.message : "msg command failed"}`);
      return 2;
    }
  }
  if (command === "dashboard") {
    try {
      const { dashboardOptions, startDashboard } = await import("./dashboard");
      const options = dashboardOptions(args.slice(1));
      const dashboard = startDashboard({ port: options.port });
      const url = `http://127.0.0.1:${dashboard.port}/`;
      console.log(`kiln: dashboard at ${url}`);
      if (options.open && Bun.which("xdg-open"))
        Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      else if (options.open) console.error("kiln: xdg-open is not on PATH; open the address yourself");
      const stop = () => {
        dashboard.stop();
        process.exit(0);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await new Promise(() => {});
    } catch (error) {
      console.error(`kiln: ${error instanceof Error ? error.message : "dashboard failed"}`);
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
        const { startServer } = await import("./server");
        const pairing = new Pairing();
        let server: ReturnType<typeof startServer> | undefined;
        try {
          server = startServer({ port: options.port, pairing });
          console.log(`kiln: listening on http://127.0.0.1:${server.port}`);
          if (!options.local) {
            const origin = options.origin ?? (await setupTailscale(server.port ?? options.port));
            console.log(`kiln: phone access at ${origin}`);
            // A service's log is no place for a pairing code, even a short-lived one.
            if (process.stdout.isTTY) await printInvitation(pairing, origin);
            else console.log(`kiln: run kiln pair ${origin} to add a phone`);
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
        const { runSetup, spawn } = await import("./setup");
        const origin = await runSetup(args.slice(1));
        const { printInvitation } = await import("./serve");
        const pairing = new Pairing();
        try {
          await printInvitation(pairing, origin);
        } finally {
          pairing.close();
        }
        // A tunnel of your own has no Tailscale Serve to put OpenCode's web UI on.
        if (!args.includes("--origin")) {
          const { setupOpencodeWeb } = await import("./opencode-web");
          console.log(`kiln: ${(await setupOpencodeWeb(origin, { run: spawn })).note}`);
        }
        return 0;
      }
      if ((command === "devices" && args.length !== 1) || (command === "revoke" && args.length !== 2))
        throw new Error(usage);
      const pairing = new Pairing();
      try {
        switch (command) {
          case "pair": {
            const positional = args.slice(1).filter((arg) => arg !== "--qr");
            if (positional.length > 1) throw new Error(usage);
            const { printInvitation, tailscaleOrigin } = await import("./serve");
            const origin = positional[0] ? serverOrigin(positional[0] ?? "") : await tailscaleOrigin();
            await printInvitation(pairing, origin);
            return 0;
          }
          case "devices":
            for (const device of pairing.devices()) {
              console.log(`${device.id}  ${device.name}`);
              for (const start of pairing.starts(device.id))
                console.log(`  started ${start.agent} in ${start.directory} at ${new Date(start.at).toISOString()}`);
            }
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
  if (command === "resume") {
    try {
      const { runResumeCli } = await import("./resume-cli");
      return await runResumeCli(args.slice(1));
    } catch (error) {
      console.error(`kiln: ${error instanceof Error ? error.message : "resume failed"}`);
      return 2;
    }
  }
  if (command === "close") {
    try {
      const { runCloseCli } = await import("./close-cli");
      return await runCloseCli(args.slice(1));
    } catch (error) {
      console.error(`kiln: ${error instanceof Error ? error.message : "close failed"}`);
      return 2;
    }
  }
  if (command === "status") {
    // The counts need no terminal ownership, and every tmux client asks every few seconds.
    console.log(await cachedStatus(async () => summarise(await listSessions({ kitty: false }))));
    return 0;
  }
  if (command === "--help" || command === "-h") {
    console.log(usage);
    return 0;
  }
  console.error(`kiln: unknown argument "${command}"\n${usage}`);
  return 2;
}
