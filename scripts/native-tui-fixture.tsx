import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { nativeSavedSessions } from "../src/native-resume";
import type { Session } from "../src/sessions";
import { defaults } from "../src/settings";
import { kill } from "../src/tmux";

const root = mkdtempSync(join(tmpdir(), "kiln-saved-native-tui-"));
const id = "00000000-0000-0000-0000-000000000001";
const name = `codex-bg-${id.slice(0, 16)}`;
Bun.env.TERM = "xterm-256color";
Bun.env.KILN_ACP_SOCKET = join(root, "host.sock");
mkdirSync(join(root, "bin"));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const command = join(root, "bin", "codex");
writeFileSync(
  command,
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(`${import.meta.dir}/native-agent-fixture.ts`)} "$@"\n`,
);
chmodSync(command, 0o755);
Bun.env.PATH = `${join(root, "bin")}:${Bun.env.PATH}`;
const session: Session = {
  agent: "codex",
  id: "saved-kiln-id",
  title: "Native conversation",
  cwd: process.cwd(),
  startedAt: Date.now(),
  activity: "idle",
  place: { kind: "acp", id: "saved-kiln-id" },
};
writeFileSync(
  `${Bun.env.KILN_ACP_SOCKET}.json`,
  JSON.stringify([{ conversation: { session, messages: [], approvals: [] }, providerId: id, command: ["codex-acp"] }]),
);
let released = false;
const host = Bun.serve({
  unix: Bun.env.KILN_ACP_SOCKET,
  fetch(request) {
    if (new URL(request.url).pathname !== "/sessions/saved-kiln-id/close" || request.method !== "POST")
      return new Response("Unexpected ACP call", { status: 400 });
    released = true;
    return Response.json({ ok: true });
  },
});
const renderer = await createCliRenderer({ exitOnCtrlC: false });
const quit = () => {
  kill(name);
  host.stop(true);
  rmSync(root, { recursive: true, force: true });
  renderer.destroy();
  process.exit(0);
};
process.once("SIGTERM", quit);
createRoot(renderer).render(
  <App
    initialSettings={{ ...defaults, statusBar: false, notifications: false }}
    onQuit={quit}
    loadSessions={async () =>
      nativeSavedSessions(released ? [] : [session]).map((row) => ({
        ...row,
        place:
          row.place.kind === "background"
            ? { ...row.place, attach: [command, ...row.place.attach.slice(1)] }
            : row.place,
      }))
    }
  />,
);
