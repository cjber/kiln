import packageJson from "../package.json";
import { listSessions, summarise } from "./sessions";

const usage = `usage: kiln            open the session list
       kiln status     print session counts (used by the in-session status bar)
       kiln --version`;

/** Anything but the bare TUI is handled here; an unknown argument is an error, never a silent TUI launch. */
export async function runCli(args: string[]): Promise<number | undefined> {
  const [command] = args;
  if (command === undefined) return undefined;
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
