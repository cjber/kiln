import { syncBundledSkills } from "./bundled-skills";
import { runCli } from "./cli";
import { installPiExtension } from "./pi-install";
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

const skillProblems = syncBundledSkills();
try {
  installPiExtension(undefined, true);
} catch (error) {
  skillProblems.push(error instanceof Error ? error.message : "Cannot update the Pi extension");
}
const [{ createCliRenderer }, { createRoot }, { App }] = await Promise.all([
  import("@opentui/core"),
  import("@opentui/react"),
  import("./app"),
]);
const renderer = await createCliRenderer({ exitOnCtrlC: false });

const quit = () => {
  renderer.destroy();
  process.exit(0);
};

process.once("SIGINT", quit);
process.once("SIGTERM", quit);
process.once("SIGHUP", quit);
createRoot(renderer).render(<App initialSettings={settings} onQuit={quit} initialNotice={skillProblems.join("; ")} />);
