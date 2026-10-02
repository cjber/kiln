import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { driver } from "./tuistory";

const name = `kiln-native-e2e-${process.pid}`;
const output = `/tmp/${name}`;
mkdirSync(output, { recursive: true });
const drive = driver(name, 19475);
try {
  await drive(
    "--cols",
    "100",
    "--rows",
    "24",
    "--env",
    `KILN_TMUX_SERVER=${name}`,
    "--env",
    "TERM=xterm-256color",
    "--",
    "bun",
    "scripts/native-tui-fixture.tsx",
  );
  await drive("wait", "Native conversation");
  await drive("press", "enter");
  await drive("wait", "Native TUI fixture");
  await drive("type", "a direct native prompt");
  await drive("press", "enter");
  await drive("wait", "Native reply: a direct native prompt");
  await drive("screenshot", "-o", join(output, "native-message.png"));
  await drive("press", "ctrl", "q");
  await drive("wait", "Native conversation");
  await drive("press", "enter");
  await drive("wait", "Native reply: a direct native prompt");
  await drive("resize", "60", "16");
  await drive("type", "after reattach");
  await drive("press", "enter");
  await drive("wait", "Native reply: after reattach");
  await drive("press", "ctrl", "q");
  await drive("wait", "q quit");
  await drive("press", "q");
  console.log(`Native TUI input, detach, reattach and resize passed; screenshots: ${output}`);
} finally {
  await drive("close").catch(() => {});
  Bun.spawnSync(["tmux", "-L", name, "kill-server"], { stdout: "ignore", stderr: "ignore" });
}
