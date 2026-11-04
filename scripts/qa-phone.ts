/**
 * For exploratory QA (Bugpatrol) of the phone app: boot a dedicated emulator, install the debug build, serve seeded
 * sessions over local TLS at https://10.0.2.2:8443 and open a pairing invitation for it. `bun scripts/qa-phone.ts
 * [SEED]` prints `kiln QA phone ready` and serves until stopped; stopping it shuts the emulator down. It never touches
 * a paired phone, the user's phone server or their real sessions.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pairing } from "../src/pairing";
import { startServer } from "../src/server";
import type { Session } from "../src/sessions";
import { seeds } from "./qa-sessions";

const seed = Bun.argv[2] ?? "short";
const seeded = seeds[seed];
if (!seeded) throw new Error(`unknown seed ${seed}; use empty, short or many`);
const root = resolve(import.meta.dir, "..");
const sdk = [Bun.env.ANDROID_HOME, Bun.env.ANDROID_SDK_ROOT, "/opt/android-sdk"].find(
  (path) => path && existsSync(join(path, "platform-tools")),
);
if (!sdk) throw new Error("no Android SDK; set ANDROID_HOME");
const adb = join(sdk, "platform-tools/adb");
const avd = "kiln-qa";
const serial = "emulator-5562";
const port = 8443;
const scratch = mkdtempSync(join(tmpdir(), "kiln-qa-phone-"));

function run(command: string[], options: { input?: string; env?: Record<string, string> } = {}): string {
  const result = Bun.spawnSync(command, {
    stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
    env: { ...Bun.env, ANDROID_HOME: sdk, ...options.env },
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString() || result.stdout.toString()}`);
  return result.stdout.toString().trim();
}
const device = (...args: string[]) => run([adb, "-s", serial, ...args]);

let emulator: Bun.Subprocess | undefined;
let stopServer: (() => void) | undefined;
function cleanup() {
  stopServer?.();
  if (emulator) {
    Bun.spawnSync([adb, "-s", serial, "emu", "kill"]);
    emulator.kill();
  }
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });

try {
  run([join(root, "android/gradlew"), "-p", join(root, "android"), "--no-daemon", "-q", "assembleDebug"]);

  if (!run([adb, "devices"]).includes(`${serial}\t`)) {
    if (
      !run([join(sdk, "emulator/emulator"), "-list-avds"])
        .split("\n")
        .includes(avd)
    )
      run(
        [
          join(sdk, "cmdline-tools/latest/bin/avdmanager"),
          "create",
          "avd",
          "-n",
          avd,
          "-k",
          "system-images;android-35;google_apis;x86_64",
          "-d",
          "pixel_7",
        ],
        { input: "no\n" },
      );
    emulator = Bun.spawn(
      [join(sdk, "emulator/emulator"), "-avd", avd, "-port", "5562", "-no-window", "-no-audio", "-no-snapshot"],
      { stdout: Bun.file(join(scratch, "emulator.log")), stderr: "inherit", env: { ...Bun.env, ANDROID_HOME: sdk } },
    );
  }
  const deadline = Date.now() + 240_000;
  while (
    Bun.spawnSync([adb, "-s", serial, "shell", "getprop", "sys.boot_completed"]).stdout.toString().trim() !== "1"
  ) {
    if (Date.now() > deadline) throw new Error("the QA emulator did not boot within four minutes");
    await Bun.sleep(2000);
  }
  if (device("emu", "avd", "name").split("\n")[0]?.trim() !== avd)
    throw new Error(`${serial} belongs to another emulator; refusing to use it`);
  for (const setting of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"])
    device("shell", "settings", "put", "global", setting, "0");

  // A throwaway CA the debug build trusts as a user certificate; release builds never do.
  const file = (name: string) => join(scratch, name);
  run(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=kiln QA CA"].concat([
      "-keyout",
      file("ca.key"),
      "-out",
      file("ca.pem"),
    ]),
  );
  await Bun.write(file("san.cnf"), "subjectAltName=IP:10.0.2.2,DNS:localhost\n");
  run(
    ["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=10.0.2.2", "-keyout", file("leaf.key")].concat([
      "-out",
      file("leaf.csr"),
    ]),
  );
  run(
    ["openssl", "x509", "-req", "-in", file("leaf.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key")].concat([
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      file("san.cnf"),
      "-out",
      file("leaf.pem"),
    ]),
  );
  const hash = run(["openssl", "x509", "-subject_hash_old", "-noout", "-in", file("ca.pem")]);
  run([adb, "-s", serial, "root"]);
  run([adb, "-s", serial, "wait-for-device"]);
  device("shell", "mkdir", "-p", "/data/misc/user/0/cacerts-added");
  device("push", file("ca.pem"), `/data/misc/user/0/cacerts-added/${hash}.0`);
  device("shell", "chmod", "644", `/data/misc/user/0/cacerts-added/${hash}.0`);

  device("install", "-r", join(root, "android/app/build/outputs/apk/debug/app-debug.apk"));
  device("shell", "pm", "clear", "com.cjber.kiln");

  // Sessions change over time so live updates, waiting counts and reconnects have something to show.
  let tick = 0;
  const sessions = (): Session[] =>
    seeded.map((session, index) =>
      index === 1 && session.activity
        ? { ...session, activity: tick % 2 ? "waiting" : "working", lastActiveAt: Date.now() }
        : session,
    );
  const timer = setInterval(() => tick++, 20_000);
  const pairing = new Pairing(file("devices.sqlite"));
  const server = startServer({
    port,
    pairing,
    discover: async () => ({ sessions: sessions(), problem: "", stale: false }),
    tls: { cert: Bun.file(file("leaf.pem")), key: Bun.file(file("leaf.key")) },
  });
  stopServer = () => {
    clearInterval(timer);
    server.stop();
  };
  const invitation = new URL("kiln://pair");
  invitation.searchParams.set("server", `https://10.0.2.2:${port}`);
  invitation.searchParams.set("code", pairing.invite());
  device(
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `'${invitation.href}'`,
    "com.cjber.kiln",
  );
  console.log(`invitation: ${invitation.href}`);
  console.log("kiln QA phone ready");
  await new Promise(() => {});
} catch (error) {
  cleanup();
  throw error;
}
