import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import type { Session } from "../src/sessions";
import { defaults } from "../src/settings";

const state = Bun.env.KILN_E2E_SESSIONS;
if (!state) throw new Error("KILN_E2E_SESSIONS is required");
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(
  <App
    initialSettings={{ ...defaults, cloud: false, notifications: false }}
    onQuit={() => {
      renderer.destroy();
      process.exit(0);
    }}
    loadSessions={async () => (await Bun.file(state).json()) as Session[]}
  />,
);
