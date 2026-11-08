import { parseArgs } from "node:util";
import { resumeStopped } from "./launcher";
import { sessionTitle } from "./session-list";
import { listSessions, type Session, sessionIdentity } from "./sessions";
import { loadSettings } from "./settings";

const resumeUsage = `usage: kiln resume <name...|--all> [--prompt TEXT]
                                  resume sessions a restart stopped, one at a time; no names lists them`;

/** The sessions a name picks: its whole `agent:id` name, or a unique prefix of it or of the id. */
export function pickSessions(sessions: readonly Session[], names: readonly string[], kind: string): Session[] {
  return names.map((name) => {
    const found = sessions.filter((session) => {
      const identity = sessionIdentity(session);
      return identity === name || identity.startsWith(name) || session.id?.startsWith(name);
    });
    if (found.length === 1 && found[0]) return found[0];
    throw new Error(found.length ? `"${name}" names more than one ${kind} session` : `no ${kind} session "${name}"`);
  });
}

/** `kiln resume`: what `Enter` does on a `stopped` row, for every session asked for. Returns the failures. */
export async function runResumeCli(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { all: { type: "boolean" }, prompt: { type: "string" } },
  });
  const settings = loadSettings();
  const stopped = (await listSessions({ kitty: false })).filter((session) => session.place.kind === "saved");
  if (!values.all && !positionals.length) {
    for (const session of stopped) console.log(`${sessionIdentity(session)}  ${sessionTitle(session)}`);
    if (!stopped.length) console.log("no stopped sessions");
    return 0;
  }
  if (values.all && positionals.length) throw new Error(resumeUsage);
  const chosen = values.all ? stopped : pickSessions(stopped, positionals, "stopped");
  let failed = 0;
  // One at a time: each must still be running after its grace period before the next starts.
  for (const session of chosen) {
    const result = await resumeStopped(session, settings, values.prompt || undefined);
    if ("name" in result) console.log(`resumed ${sessionIdentity(session)} in ${result.name}`);
    else {
      failed++;
      console.error(`kiln: could not resume ${sessionIdentity(session)}: ${result.problem}`);
    }
  }
  return failed ? 1 : 0;
}
