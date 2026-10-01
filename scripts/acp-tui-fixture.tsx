import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { acpRequest, startAcpHost } from "../src/acp-host";
import { App } from "../src/app";
import type { Session } from "../src/sessions";
import { loadSettings } from "../src/settings";

const host = startAcpHost();
const session = await acpRequest<Session>("/sessions", { agent: "pi", cwd: process.cwd() });
if (!session.id) throw new Error("ACP fixture has no identity");
await acpRequest(`/sessions/${session.id}/prompt`, { text: "approve this" });
const renderer = await createCliRenderer({ exitOnCtrlC: false });
const quit = () => {
  host.stop();
  renderer.destroy();
  process.exit(0);
};
process.once("SIGTERM", quit);
createRoot(renderer).render(
  <App initialSettings={loadSettings()} onQuit={quit} loadSessions={() => acpRequest<Session[]>("/sessions")} />,
);
