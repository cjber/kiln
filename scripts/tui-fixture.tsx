/**
 * The production App on a real terminal with sessions from a JSON file, for scripts/tui-e2e.ts.
 *
 *   KILN_FIXTURE_SESSIONS=rows.json bun scripts/tui-fixture.tsx
 *
 * Only the list source differs from src/index.tsx: the file is re-read on every refresh, so a test can
 * change the rows while the TUI runs. Attach, settings and keys are the real ones.
 */

import { readFileSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "../src/app";
import type { Session } from "../src/sessions";
import { loadSettings } from "../src/settings";

const path = Bun.env.KILN_FIXTURE_SESSIONS;
if (!path) throw new Error("KILN_FIXTURE_SESSIONS must name a JSON file of sessions");

const settings = loadSettings();
const renderer = await createCliRenderer({ exitOnCtrlC: false });
const quit = () => {
  renderer.destroy();
  process.exit(0);
};
process.once("SIGTERM", quit);
process.once("SIGHUP", quit);
createRoot(renderer).render(
  <App
    initialSettings={settings}
    onQuit={quit}
    loadSessions={async () => JSON.parse(readFileSync(path, "utf8")) as Session[]}
  />,
);
