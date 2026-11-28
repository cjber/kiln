/**
 * For exploratory QA of the web client: serve seeded sessions over local TLS at https://localhost:8444 with phone
 * writes on, and print a browser pairing link. `bun scripts/qa-web.ts [SEED]` prints `kiln QA web ready` and serves
 * until stopped. It never touches the user's phone server, paired devices or real sessions. The "finished" Claude
 * session waits on a captured permission menu, so the menu's buttons have something to answer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pairing } from "../src/pairing";
import { type Session, sessionDirectory } from "../src/sessions";
import { defaults } from "../src/settings";
import { seededTranscript, seeds } from "./qa-sessions";

const seed = Bun.argv[2] ?? "short";
const seeded = seeds[seed];
if (!seeded) throw new Error(`unknown seed ${seed}; use empty, short or many`);
const root = resolve(import.meta.dir, "..");
const port = 8444;
const origin = `https://localhost:${port}`;
const server = "kiln-qa-web";
const scratch = mkdtempSync(join(tmpdir(), "kiln-qa-web-"));
// Transcripts, the mailbox and tmux are the harness's own, so prompts and Stop never reach a real session.
Bun.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
Bun.env.XDG_STATE_HOME = join(scratch, "state");
Bun.env.KILN_TMUX_SERVER = server;
// Imported after the environment is set, since the tmux module reads its server name as it loads.
const { startServer } = await import("../src/server");
for (const session of seeded)
  if (session.agent === "claude" && session.id) {
    const directory = join(scratch, "claude", "projects", session.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${session.id}.jsonl`), seededTranscript(session.title ?? "Fix it"));
  }

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdin: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
}
const file = (name: string) => join(scratch, name);
let stop: (() => void) | undefined;
function cleanup() {
  stop?.();
  Bun.spawnSync(["tmux", "-L", server, "kill-server"], { stderr: "ignore" });
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });

try {
  // A throwaway certificate for localhost; the browser is told to accept it.
  run(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost"].concat([
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      file("leaf.key"),
      "-out",
      file("leaf.pem"),
    ]),
  );
  const menu = join(root, "src/fixtures/prompts/perm.txt");
  run([
    "tmux",
    "-L",
    server,
    "new-session",
    "-d",
    "-s",
    "finished",
    "-x",
    "100",
    "-y",
    "40",
    `cat '${menu}'; sleep infinity`,
  ]);
  const sessions = (): Session[] =>
    seeded.map((session) =>
      session.place.kind === "kiln" && session.place.name === "finished"
        ? { ...session, activity: "waiting" }
        : session,
    );
  const pairing = new Pairing(file("devices.sqlite"));
  const listening = startServer({
    port,
    pairing,
    origin,
    discover: async () => ({ sessions: sessions(), problem: "", stale: false }),
    tls: { cert: Bun.file(file("leaf.pem")), key: Bun.file(file("leaf.key")) },
    settings: () => ({ ...defaults, zoxide: false, phoneWrite: true }),
    offer: (listed) => [...new Set(listed.map(sessionDirectory))],
  });
  stop = () => listening.stop();
  console.log(`pair: ${origin}/#pair=${pairing.invite()}`);
  console.log("kiln QA web ready");
  await new Promise(() => {});
} catch (error) {
  cleanup();
  throw error;
}
