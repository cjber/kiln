import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import type { Session } from "../src/sessions";
import { defaults } from "../src/settings";
import { kill, start } from "../src/tmux";

const name = `pi-${crypto.randomUUID()}`;
Bun.env.TERM = "xterm-256color";
const session: Session = {
  agent: "pi",
  title: "Native conversation",
  cwd: process.cwd(),
  startedAt: Date.now(),
  place: { kind: "kiln", name },
};
if (!start(name, session.cwd, [process.execPath, `${import.meta.dir}/native-agent-fixture.ts`], "pi fixture"))
  throw new Error("could not start the native TUI fixture");
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
