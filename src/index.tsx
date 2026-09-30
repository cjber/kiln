import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "./app";
import { runCli } from "./cli";
import { loadSettings, type Settings } from "./settings";

const cliExitCode = await runCli(process.argv.slice(2));
if (cliExitCode !== undefined) process.exit(cliExitCode);

// A broken settings file is reported before the TUI takes the screen, not as a silent fallback to defaults.
let settings: Settings;
try {
  settings = loadSettings();
} catch (error) {
  console.error(`kiln: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });

const quit = () => {
  renderer.destroy();
  process.exit(0);
};

process.once("SIGINT", quit);
process.once("SIGTERM", quit);
process.once("SIGHUP", quit);
createRoot(renderer).render(<App initialSettings={settings} onQuit={quit} />);
