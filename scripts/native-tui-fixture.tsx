import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import type { Session } from "../src/sessions";
import { defaults } from "../src/settings";
import { kill, start } from "../src/tmux";

const name = "native-fixture";
Bun.env.TERM = "xterm-256color";
if (!start(name, process.cwd(), [process.execPath, `${import.meta.dir}/native-agent-fixture.ts`], "Native provider"))
  throw new Error("Native fixture did not start");
const session: Session = {
  agent: "claude",
  id: "native-fixture",
  title: "Native conversation",
  cwd: process.cwd(),
  startedAt: Date.now(),
  activity: "idle",
  place: { kind: "kiln", name },
};
const renderer = await createCliRenderer({ exitOnCtrlC: false });
const quit = () => {
  kill(name);
  renderer.destroy();
  process.exit(0);
};
process.once("SIGTERM", quit);
createRoot(renderer).render(
  <App
    initialSettings={{ ...defaults, statusBar: false, notifications: false }}
    onQuit={quit}
    loadSessions={async () => [session]}
  />,
);
